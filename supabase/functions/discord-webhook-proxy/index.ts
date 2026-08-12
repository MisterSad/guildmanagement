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
  let content = "";

  try {
    const body = await req.json();
    webhookUrl = (body?.webhookUrl ?? "").toString().trim();
    content = (body?.content ?? "").toString();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  if (!webhookUrl || !content) {
    return json({ ok: false, error: "missing_webhook_url_or_content" }, 400);
  }

  webhookUrl = webhookUrl.replace(/^["']|["']$/g, "").trim();
  if (!webhookUrl.startsWith("http://") && !webhookUrl.startsWith("https://")) {
    webhookUrl = "https://" + webhookUrl;
  }

  if (
    !webhookUrl.includes("discord.com/api/webhooks") &&
    !webhookUrl.includes("discordapp.com/api/webhooks") &&
    !webhookUrl.includes("discord.com/api/v")
  ) {
    return json({ ok: false, error: "invalid_discord_webhook_url" }, 400);
  }

  try {
    const discordRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
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
