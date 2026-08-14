import { EdgeLogger } from "../_shared/logger.ts";
import { validateCallerAuth } from "../_shared/auth.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-correlation-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const logger = new EdgeLogger("ocr-guild-members", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  // 1. Mandatory JWT & RBAC Verification (SEV-02 Fix)
  const caller = await validateCallerAuth(req, SUPABASE_URL, ANON_KEY, SERVICE_ROLE);
  if (!caller.authenticated || !caller.role || (caller.role !== "guild_admin" && caller.role !== "super_admin")) {
    logger.warn("Unauthorized attempt to access OCR endpoint", {
      authenticated: caller.authenticated,
      role: caller.role,
    });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  logger.setContext({ tenantId: caller.guild, userId: caller.accountId });

  if (!GEMINI_API_KEY) {
    logger.error("GEMINI_API_KEY is not configured in Supabase secrets");
    return json({ ok: false, error: "not_configured" }, 500);
  }

  let imageBase64 = "";
  let mimeType = "image/png";

  try {
    const body = await req.json();
    imageBase64 = body?.imageBase64 || "";
    if (body?.mimeType) mimeType = body.mimeType;
  } catch (err) {
    logger.error("Failed to parse OCR request body", err);
    return json({ ok: false, error: "bad_request" }, 400);
  }

  if (!imageBase64) {
    return json({ ok: false, error: "missing_image" }, 400);
  }

  // Strip data URL header if present (e.g. data:image/png;base64,...)
  if (imageBase64.includes(";base64,")) {
    const parts = imageBase64.split(";base64,");
    const header = parts[0];
    if (header.includes("image/")) {
      mimeType = header.split("image/")[1].split(";")[0];
      mimeType = `image/${mimeType}`;
    }
    imageBase64 = parts[1];
  }

  const systemInstruction = `You are an OCR expert specializing in gaming leaderboards and guild roster screenshots for Foundation Galactic Frontier (FGF).
Your task is to analyze the image and extract all players visible in the roster or leaderboard table.

For each player detected, extract:
1. "pseudo": The player's exact in-game username/name (preserve case, special characters, and numbers).
2. "overall_power": The numerical power/puissance of the player converted into a pure integer (e.g. "145.2M" -> 145200000, "145M" -> 145000000, "12,400,000" -> 12400000, "500K" -> 500000, "98 450 120" -> 98450120).
3. "uid": Player UID if visible on screen (string of digits), otherwise null.

Return ONLY a JSON object matching this schema:
{
  "players": [
    {
      "pseudo": "string",
      "overall_power": number,
      "uid": "string or null"
    }
  ]
}`;

  const promptPayload = {
    contents: [
      {
        parts: [
          { text: systemInstruction },
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: "application/json",
      temperature: 0.1,
    },
  };

  const modelsToTry = [
    "gemini-flash-latest",
    "gemini-3.6-flash",
    "gemini-3-flash-preview",
  ];

  let geminiResultRaw = "";
  let lastError = "";

  logger.info("Initiating Gemini OCR scan", { mimeType, imageLength: imageBase64.length });

  for (const modelName of modelsToTry) {
    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promptPayload),
      });

      if (!resp.ok) {
        const errTxt = await resp.text();
        lastError = `Model ${modelName} returned ${resp.status}: ${errTxt}`;
        logger.warn("Gemini model attempt failed", { modelName, status: resp.status });
        continue;
      }

      const respData = await resp.json();
      const textCandidate = respData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (textCandidate) {
        geminiResultRaw = textCandidate;
        logger.info("Gemini OCR extraction succeeded", { modelName });
        break;
      }
    } catch (e: any) {
      lastError = `Fetch exception for ${modelName}: ${e.message}`;
      logger.warn("Exception during Gemini fetch", { modelName, error: e.message });
    }
  }

  if (!geminiResultRaw) {
    logger.error("All Gemini OCR models failed", undefined, { lastError });
    return json(
      {
        ok: false,
        error: "ocr_processing_failed",
        message: lastError || "Failed to parse image with AI OCR engine",
      },
      500
    );
  }

  try {
    const parsed = JSON.parse(geminiResultRaw);
    const rawList = Array.isArray(parsed?.players) ? parsed.players : (Array.isArray(parsed) ? parsed : []);

    // Clean and validate players defensively
    const players = rawList
      .map((p: any) => {
        const pseudo = String(p.pseudo || "").trim();
        let power = 0;
        if (typeof p.overall_power === "number") {
          power = Math.round(p.overall_power);
        } else if (typeof p.overall_power === "string") {
          const rawP = p.overall_power.replace(/[^0-9]/g, "");
          power = parseInt(rawP, 10) || 0;
        }
        const uid = p.uid ? String(p.uid).trim() : null;
        return { pseudo, overall_power: Math.max(0, power), uid };
      })
      .filter((p: any) => p.pseudo.length > 0 && p.overall_power >= 0);

    logger.info("OCR Extraction completed", { detectedCount: players.length });
    return json({ ok: true, players, count: players.length });
  } catch (e: any) {
    logger.error("Failed to parse Gemini OCR JSON response", e, { raw: geminiResultRaw });
    return json(
      { ok: false, error: "json_parse_failed", raw: geminiResultRaw },
      500
    );
  }
});
