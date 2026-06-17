// supabase/functions/send-market-order/index.ts
// Sends the Market List order to the chefs via Resend.
// Matches the send-closing-report pattern (key inline, verified domain
// kitchenteam.robertos.ae). Recipients: Danilo + Antonio.

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
    const { subject, html } = await req.json();

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: "Roberto's Kitchen <orders@kitchenteam.robertos.ae>",
        to: ['dvalla@robertos.ae', 'astellacci@robertos.ae'],
        subject: subject || 'Market Order',
        html: html || '',
      }),
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
