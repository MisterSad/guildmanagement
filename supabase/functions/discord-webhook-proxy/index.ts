import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  let webhookUrl = "";
  let payload: any = null;

  try {
    const rawBody = await req.json();
    const body = (rawBody && typeof rawBody === "object" && rawBody.body && typeof rawBody.body === "object")
      ? rawBody.body
      : rawBody;

    webhookUrl = (body?.webhookUrl ?? body?.url ?? "").toString().trim();

    if (body?.payload && typeof body.payload === "object") {
      payload = body.payload;
    } else {
      const { webhookUrl: _w, url: _u, ...rest } = body;
      payload = rest;
    }
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const hasContent = typeof payload?.content === "string" && payload.content.trim().length > 0;
  const hasEmbeds = Array.isArray(payload?.embeds) && payload.embeds.length > 0;

  if (!webhookUrl || (!hasContent && !hasEmbeds)) {
    return json({ ok: false, error: "missing_webhook_url_or_content" }, 400);
  }

  webhookUrl = webhookUrl.replace(/^[<"'\s]+|[>'"\s]+$/g, "").trim();
  if (!webhookUrl.startsWith("http://") && !webhookUrl.startsWith("https://")) {
    webhookUrl = "https://" + webhookUrl;
  }

  try {
    const u = new URL(webhookUrl);
    const hostValid = u.protocol === "https:" && (
      u.hostname === "discord.com" ||
      u.hostname === "discordapp.com" ||
      u.hostname.endsWith(".discord.com") ||
      u.hostname.endsWith(".discordapp.com")
    );
    const pathValid = u.pathname.includes("/webhooks/");
    if (!hostValid || !pathValid) {
      return json({ ok: false, error: "invalid_discord_webhook_url" }, 400);
    }
  } catch {
    return json({ ok: false, error: "invalid_discord_webhook_url" }, 400);
  }

  try {
    const discordRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (discordRes.ok || discordRes.status === 204 || discordRes.status === 200) {
      return json({ ok: true, status: discordRes.status });
    }

    const errText = await discordRes.text().catch(() => "");
    return json(
      { ok: false, status: discordRes.status, error: `Discord HTTP ${discordRes.status}: ${errText}` },
      200
    );
  } catch (err: any) {
    return json({ ok: false, error: `Server fetch to Discord failed: ${err?.message ?? err}` }, 200);
  }
});

