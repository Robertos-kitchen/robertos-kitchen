// supabase/functions/send-stock-take/index.ts
// Emails the monthly Stock Take to the cost controller + team via Resend.
// Mirrors send-market-order. Recipients are passed from the app (to + cc) so the
// Kitchen and FOH/beverage builds can use different lists without a redeploy.
//
// 28 Sep 2026 — {list:'stocktake_kitchen'}: the Kitchen stock take no longer
// passes its own to/cc. The function reads everyone ticked for that key in FOH
// Admin → Emails (app_users.notify in the FOH project, FOH_SERVICE_KEY secret),
// the same model as send-roster / send-closing-report. The old Kitchen list is
// the fallback, so an unreadable or empty list never means "emailed nobody".
// {check:true, list:...} returns who a send would reach and sends NOTHING.
// Callers that pass to/cc and no `list` (e.g. the comp tasting to Aung) are
// unchanged.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';  // set as a function secret - never in code

const FOH_URL = 'https://paoaivwtkzujmrgrfjuq.supabase.co';
// The only lists a caller may name, and who each one fell back to before it
// moved into Admin (the Kitchen stock take: Aung + Danilo, Antonio, Asarudeen, Francesco).
const LISTS: Record<string, string[]> = {
  stocktake_kitchen: ['ahtwe@robertos.ae', 'dvalla@robertos.ae', 'astellacci@robertos.ae',
                      'amohamed@robertos.ae', 'fguarracino@robertos.ae'],
};

type Lookup = { list: { email: string; name: string }[] | null; why: string | null };
async function fromAppUsers(key: string): Promise<Lookup> {
  const svc = Deno.env.get('FOH_SERVICE_KEY');
  if (!svc) return { list: null, why: 'no-key' };
  try {
    const url = FOH_URL + '/rest/v1/app_users?select=email,name&notify=cs.' + encodeURIComponent('{' + key + '}');
    const r = await fetch(url, { headers: { apikey: svc, Authorization: 'Bearer ' + svc } });
    if (!r.ok) return { list: null, why: 'http-' + r.status };
    const rows = await r.json();
    if (!Array.isArray(rows)) return { list: null, why: 'not-a-list' };
    const out = rows
      .map((x: { email?: unknown; name?: unknown }) => ({
        email: typeof x.email === 'string' ? x.email.trim().toLowerCase() : '',
        name: typeof x.name === 'string' && x.name.trim() ? x.name.trim() : '',
      }))
      .filter((x: { email: string }) => x.email.includes('@'));
    return out.length ? { list: out, why: null } : { list: null, why: 'empty' };
  } catch (_) {
    return { list: null, why: 'threw' };
  }
}
function fallbackReason(why: string | null): string {
  if (why === 'empty')  return 'the Admin → Emails list came back empty';
  if (why === 'no-key') return 'this project has no key for reading the Admin → Emails list';
  if (why === 'threw')  return 'the Admin → Emails list could not be reached';
  if (why && why.indexOf('http-') === 0) return 'the Admin → Emails list was refused (' + why + ')';
  return 'the Admin → Emails list could not be read';
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
});

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        // 22 Sept 2026 — this list used to be 'Content-Type, Authorization'. The
        // Events comp-tasting send also sent an `apikey` header, so the browser
        // answered the preflight, saw apikey missing from the allow-list and
        // refused to send the POST: the chef got "Failed to fetch" four times
        // and no request ever reached here. The app no longer sends apikey, but
        // a caller that does must not be silently blocked again — so accept the
        // same set the project's seven other functions already accept.
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  try {
    const body = await req.json();
    const { to, cc, subject, html, attachments } = body;

    // A named list: recipients come from Admin, never from the caller.
    const listKey = typeof body.list === 'string' && LISTS[body.list] ? body.list : null;
    let look: Lookup | null = null;
    let named: { email: string; name: string }[] = [];
    if (listKey) {
      look = await fromAppUsers(listKey);
      named = look.list || LISTS[listKey].map((e) => ({ email: e, name: '' }));
    }
    const usedFallback = !!look && look.list === null;
    const reason = usedFallback && look ? fallbackReason(look.why) : null;

    if (body.check === true) {
      if (!listKey) return json({ checked: false, error: 'check needs a known list' }, 400);
      return json({ checked: true, sent: false, recipients: named.map((x) => x.email),
                    names: named.map((x) => x.name), usedFallback, fallbackReason: reason });
    }

    // normalise: accept a string or an array for both to + cc
    const toList = listKey ? named.map((x) => x.email)
      : (Array.isArray(to) ? to : (to ? [to] : ['ahtwe@robertos.ae']));
    const ccList = listKey ? [] : (Array.isArray(cc) ? cc : (cc ? [cc] : []));

    // attachments: [{ filename, content }] where content is a base64 string
    // (the app sends the stock take as an .xlsx). Pass through to Resend.
    const attList = Array.isArray(attachments) ? attachments : [];

    const payload: Record<string, unknown> = {
      from: "Roberto's Kitchen <orders@kitchenteam.robertos.ae>",
      to: toList,
      cc: ccList,
      subject: subject || 'Stock Take',
      html: html || '',
    };
    if (attList.length) payload.attachments = attList;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    console.log('RESEND STATUS:', res.status, 'RESPONSE:', JSON.stringify(data));

    if (listKey) {
      return json({ ...data, ok: res.ok, recipients: toList, names: named.map((x) => x.name),
                    usedFallback, fallbackReason: reason }, res.ok ? 200 : 500);
    }
    return new Response(JSON.stringify(data), {
      status: res.ok ? 200 : 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.log('FUNCTION ERROR:', String(e));
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  }
});
