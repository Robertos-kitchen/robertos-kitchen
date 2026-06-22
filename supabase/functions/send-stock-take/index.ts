// supabase/functions/send-stock-take/index.ts
// Emails the monthly Stock Take to the cost controller + team via Resend.
// Mirrors send-market-order. Recipients are passed from the app (to + cc) so the
// Kitchen and FOH/beverage builds can use different lists without a redeploy.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_API_KEY = 're_DV2gjCqH_4JmjoPbm4PLanhPRoXmkiYCs';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  try {
    const { to, cc, subject, html, attachments } = await req.json();

    // normalise: accept a string or an array for both to + cc
    const toList = Array.isArray(to) ? to : (to ? [to] : ['ahtwe@robertos.ae']);
    const ccList = Array.isArray(cc) ? cc : (cc ? [cc] : []);

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
