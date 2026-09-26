import { z } from "https://esm.sh/zod@3.23.8";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { validateCallerAuth } from "../_shared/auth.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { getValidatedEnv } from "../_shared/env.ts";
import { GEMINI_MODEL_FALLBACKS, geminiGenerateContentUrl } from "../_shared/gemini.ts";

export interface OcrImageItem {
  base64Data: string;
  mimeType?: string;
}

export interface OcrHashMetadata {
  metricType: string;
  guildTag?: string | null;
  rankHint?: string | null;
  scanDay?: number | null;
}

export async function computeOcrPayloadHash(
  images: OcrImageItem[],
  metadata: OcrHashMetadata
): Promise<string> {
  const payload = JSON.stringify({
    images: images.map((img) => img.base64Data),
    metricType: metadata.metricType,
    guildTag: metadata.guildTag || null,
    rankHint: metadata.rankHint || null,
    scanDay: metadata.scanDay || null,
  });
  const encoded = new TextEncoder().encode(payload);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

const env = getValidatedEnv();
const GEMINI_API_KEY = env.GEMINI_API_KEY || "";
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.SUPABASE_ANON_KEY;

export const GUILD_TAG_REGEX = /^[A-Za-z0-9_-]{1,10}$/;

export const VALID_METRICS = [
  "members",
  "power",
  "fleet",
  "tech",
  "flagship",
  "champs",
  "crew",
  "glory",
  "svs_prep",
  "svs_pvp",
  "gvg_prep",
  "gvg_pvp",
  "svs_day",
  "gvg_day",
  "shadowfront_s1",
  "shadowfront_s2",
  "dtr",
  "armsrace_sa",
  "armsrace_sb",
] as const;

export const VALID_RANKS = ["R4", "R3", "R2", "R1"] as const;
export const VALID_RANKS_SET = new Set<string>(VALID_RANKS);

export const ImageItemSchema = z
  .object({
    base64Data: z.string().min(1),
    mimeType: z.string().optional().default("image/png"),
  })
  .strict();

export const GuildTagSchema = z
  .string()
  .trim()
  .transform((val) => val.replace(/^\[|\]$/g, "").trim())
  .pipe(z.string().regex(GUILD_TAG_REGEX).or(z.literal("")))
  .optional()
  .nullable();

// Strictly typed metadata schema
// scanDay is the validated target preparation day (1..6) for the per-day war
// metrics (svs_day / gvg_day). It is a strict integer enum enforced by Zod —
// never interpolated from a raw, uncontrolled string into the prompt.
export const MetadataSchema = z
  .object({
    metricType: z.enum(VALID_METRICS).optional(),
    guildTag: GuildTagSchema,
    rankHint: z.enum(VALID_RANKS).optional().nullable(),
    scanDay: z.number().int().min(1).max(6).optional(),
  })
  .strict();

// Request schema
export const OcrRequestSchema = z.object({
  images: z.array(ImageItemSchema).max(5).optional(),
  imageBase64: z.string().optional(),
  mimeType: z.string().optional(),
  metricType: z.string().trim().toLowerCase().optional(),
  guildTag: GuildTagSchema,
  rankHint: z.enum(VALID_RANKS).optional().nullable(),
  metadata: MetadataSchema.optional(),
});

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

function normalizeDecimalString(str: string): string {
  const s = str.replace(/\s/g, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      // European: 1.234,5 -> remove dots, replace comma with dot
      return s.replace(/\./g, "").replace(",", ".");
    } else {
      // US: 1,234.5 -> remove commas
      return s.replace(/,/g, "");
    }
  }

  if (hasComma && !hasDot) {
    return s.replace(",", ".");
  }

  return s;
}

/**
 * Deterministically parses an OCR score from either numerical values or raw OCR strings.
 * Handles German/European localizations where 'T' / 'Tsd' stands for Tausend (1,000),
 * comma ',' is a decimal separator, and period '.' is a thousands separator.
 * Also protects against runaway trillion/billion multiplier misinterpretations by Gemini.
 */
export function parseOcrScore(rawScore: unknown, rawText?: string | null): number {
  const text = (rawText || (typeof rawScore === "string" ? rawScore : "")).trim();
  if (text) {
    const match = text.match(/^[~><≈]?\s*([0-9\s.,]+)\s*([a-zA-Z.]+)?$/);
    if (match) {
      const numStr = match[1].trim();
      const rawSuffix = (match[2] || "").trim().toLowerCase();

      // Multiplier resolution:
      // In FGF game scale, 't' / 'tsd' is German Tausend (1,000). Scores never reach trillions.
      let multiplier = 1;
      if (rawSuffix.startsWith("t") || rawSuffix.startsWith("k")) {
        multiplier = 1_000;
      } else if (rawSuffix.startsWith("m") && !rawSuffix.startsWith("mrd")) {
        multiplier = 1_000_000;
      } else if (rawSuffix.startsWith("b") || rawSuffix.startsWith("mrd") || rawSuffix.startsWith("g")) {
        multiplier = 1_000_000_000;
      }

      if (multiplier > 1) {
        // Normalize decimal separator: "67,4" -> "67.4", "24.98" -> "24.98", "1.234,5" -> "1234.5"
        const clean = normalizeDecimalString(numStr);
        const val = parseFloat(clean);
        if (Number.isFinite(val) && val >= 0) {
          return Math.round(val * multiplier);
        }
      } else {
        // No suffix or multiplier 1
        // Single dot or comma followed by exactly 3 digits: European thousands separator (e.g. "5.663", "12.550")
        if (/^\d{1,3}[.,]\d{3}$/.test(numStr)) {
          const val = parseInt(numStr.replace(/[.,]/g, ""), 10);
          if (Number.isFinite(val)) return val;
        }
        // General digit cleaner for numbers like "12.400.000" or "12,400,000" or "5663"
        const cleanDigits = numStr.replace(/[^0-9]/g, "");
        const val = parseInt(cleanDigits, 10);
        if (Number.isFinite(val)) return val;
      }
    }
  }

  // Fallback for purely numeric rawScore
  if (typeof rawScore === "number" && Number.isFinite(rawScore)) {
    // Trillion / runaway inflation guard: FGF scores never exceed 9,999,999,999.
    if (rawScore > 9_999_999_999) {
      if (rawScore >= 1_000_000_000_000) {
        // E.g. 67.4 * 10^12 -> 67400000000000 / 10^9 = 67400
        return Math.round(rawScore / 1_000_000_000);
      }
      if (rawScore >= 10_000_000_000) {
        // E.g. 67.4 * 10^9 -> 67400000000 / 10^6 = 67400
        return Math.round(rawScore / 1_000_000);
      }
    }
    return Math.max(0, Math.round(rawScore));
  }

  return 0;
}

const SYSTEM_INSTRUCTION = `You are an OCR expert specializing in gaming leaderboards and guild roster screenshots for Foundation Galactic Frontier (FGF).
Analyze the provided screenshot image(s) and extract leaderboard or roster data strictly according to the task metadata and response schema.

Core Guidelines:
1. Extraction:
   - Exhaustiveness: Scan each image completely from top to bottom. Do NOT skip or omit any player row, even if their score is zero, contains non-Latin or unusual gamer symbols, or appears partially scrolled.
   - "pseudo": Clean in-game player username. Strip any leading guild tag prefix (e.g. "[TAG]") and brackets so "pseudo" contains only the player name. Preserve exact case, numbers, and gamer symbols.
   - "guild_tag": Guild tag if visible, otherwise null.
   - "score": Numerical value converted to an integer.
   - "raw_score": Exact score string visible on screen (e.g. "67,4T", "24,98T", "5.663", "145.2M", "500K").
   - "uid": Player UID if visible on screen (string of digits), otherwise null.
   - "rank": The player's rank section ("R4", "R3", "R2", "R1", or null if not applicable/undeterminable).
   - Overlap / Boundary rows: If a row is partially visible at the bottom or top of an image, extract all visible parts; client deduplication will safely reconcile cross-image duplicates.

2. Number Formatting, Multipliers & European/German Localizations:
   CRITICAL: In Foundation Galactic Frontier (FGF), player scores and powers NEVER reach trillions. Maximum scores are in millions or low billions (capped below 10 Billion).
   - "T" / "Tsd" suffix: In German and European game interfaces (e.g. "Schadensrangliste", "Gesamtschaden", "Phase B", "Händlergilde"), "T" stands for TAUSEND (THOUSAND = 1,000 / 10^3), NOT Trillion!
     * "67,4T" -> 67400 (67.4 * 1,000)
     * "24,98T" -> 24980 (24.98 * 1,000)
     * "12,55T" -> 12550 (12.55 * 1,000)
     * "500T" -> 500000 (500 * 1,000)
     NEVER treat "T" as trillion (10^12)! "T" ALWAYS means thousand (multiply by 1,000).
   - "K" / "k" suffix: Thousands (multiply by 1,000, e.g. "500K" -> 500000, "25K" -> 25000).
   - "M" / "Mio" suffix: Millions (multiply by 1,000,000, e.g. "145.2M" -> 145200000, "1,2M" -> 1200000).
   - "B" / "Mrd" suffix: Billions (multiply by 1,000,000,000, e.g. "2.16B" -> 2160000000).
   - Separators:
     * Comma is a decimal separator in European notation: "67,4T" is 67.4 thousand = 67400.
     * Period can be a thousands separator: "5.663" is 5663, "12.400.000" is 12400000.
   - Leaderboard Coherence:
     Leaderboard rankings are ALWAYS in descending order of score. For example, Rank 24: 67,4T (67,400) > Rank 25: 24,98T (24,980) > Rank 26: 12,55T (12,550) > Rank 27: 5.663 (5,663). Any interpretation where 67,4T is millions or trillions while rank 27 is 5,663 is strictly WRONG.

3. Rank Section Detection (Roster Mode):
   - "Executive Manager" header -> rank "R4"
   - "Rank 3 Members" header -> rank "R3"
   - "Rank 2 Members" header -> rank "R2"
   - "Rank 1 Members" header -> rank "R1"
   Players belong to the most recent section header above them across consecutive images. If players appear before any visible header, use the incoming rank_hint from the extraction task metadata. Report "endingRank" as the active rank section at the bottom of the last image.

4. Multi-guild Leaderboards:
   If a target guild_tag is specified in task metadata, target guild members with that tag and clean any tag prefix from the pseudo.

5. Output format:
   Return ONLY a valid JSON object strictly conforming to the requested schema. Never output explanations or markdown outside the JSON.`;

Deno.serve(async (req: Request) => {
  const json = makeJson(req);
  const logger = new EdgeLogger("ocr-guild-members", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  // Check early payload size via content-length header (max 8MB)
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > 8 * 1024 * 1024) {
    return json({ ok: false, error: "payload_too_large" }, 413);
  }

  // 1. Mandatory JWT & RBAC Verification (SEV-02 Fix)
  const caller = await validateCallerAuth(req, SUPABASE_URL, ANON_KEY, SERVICE_ROLE);
  if (!caller.authenticated || !caller.role || (caller.role !== "guild_admin" && caller.role !== "server_admin" && caller.role !== "super_admin")) {
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

  let rawBody: any;
  try {
    rawBody = await req.json();
  } catch (err) {
    logger.error("Failed to parse OCR request body", err);
    return json({ ok: false, error: "bad_request" }, 400);
  }

  // Enforce image count cap before full processing
  const body = rawBody;
  if (Array.isArray(body?.images) && body.images.length > 5) {
    return json({ ok: false, error: "too_many_images" }, 400);
  }

  const parseResult = OcrRequestSchema.safeParse(rawBody);
  if (!parseResult.success) {
    logger.warn("OCR payload validation failed", { errors: parseResult.error.issues });
    return json({ ok: false, error: "invalid_payload", details: parseResult.error.issues }, 400);
  }

  const { images, imageBase64: rawBase64, mimeType: rawMime, metadata } = parseResult.data;

  // Resolve metadata: prioritize metadata object if provided, otherwise top-level parameters
  let metricType = (metadata?.metricType || parseResult.data.metricType || "power").toLowerCase().trim();
  if (!VALID_METRICS.includes(metricType as any)) {
    metricType = "power";
  }

  const guildTag = (metadata?.guildTag ?? parseResult.data.guildTag ?? "").trim();
  const rankHint = metadata?.rankHint ?? parseResult.data.rankHint ?? null;
  // Strict int enum (1..6) enforced by MetadataSchema — never raw user text.
  const scanDay = metadata?.scanDay;
  const imagesArray = images || [];
  let imageBase64 = rawBase64 || "";
  let mimeType = rawMime || "image/png";

  // Validate parsed payload total size
  let totalDataLength = imageBase64.length;
  for (const img of imagesArray) {
    totalDataLength += (img.base64Data || "").length;
  }
  if (totalDataLength > 8 * 1024 * 1024) {
    return json({ ok: false, error: "payload_too_large" }, 413);
  }

  if (!imageBase64 && imagesArray.length === 0) {
    return json({ ok: false, error: "missing_image" }, 400);
  }

  const normalizedImages: OcrImageItem[] = imagesArray.length > 0
    ? imagesArray
    : [{ base64Data: imageBase64, mimeType }];

  const cacheKey = await computeOcrPayloadHash(normalizedImages, {
    metricType,
    guildTag,
    rankHint,
    scanDay: scanDay ?? null,
  });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  try {
    const { data: cached } = await admin
      .from("ocr_cache")
      .select("metric_type, players, ending_rank, expires_at")
      .eq("hash", cacheKey)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (cached && Array.isArray(cached.players)) {
      logger.info("OCR cache hit - returning cached result", { hash: cacheKey, metricType, count: cached.players.length });
      return json({
        ok: true,
        metricType: cached.metric_type,
        players: cached.players,
        count: cached.players.length,
        endingRank: cached.ending_rank,
        cached: true,
      });
    }
  } catch (cacheLookupErr: any) {
    logger.warn("OCR cache lookup failed, continuing to live extraction", { error: cacheLookupErr?.message });
  }

  const isMultiGuild = ["fleet", "flagship", "champs", "crew", "svs_prep", "svs_pvp", "gvg_prep", "gvg_pvp", "svs_day", "gvg_day"].includes(metricType);
  const isMembersRoster = metricType === "members";

  const metricInstructions: Record<string, string> = {
    members: `Full Guild Roster / Liste des Membres. Extract player pseudo, player UID if visible, in-game rank section (see rank instructions below), and total overall power converted into pure numerical integer. Convert strings like "145.2M" -> 145200000, "12,400,000" -> 12400000, "500K" -> 500000.`,
    power: `Overall Total Power / Puissance Totale. Extract player pseudo and total numerical power. Convert strings like "145.2M" -> 145200000, "12,400,000" -> 12400000, "500K" -> 500000.`,
    fleet: `Strongest Fleet Rating / Plus Forte Flotte (March 1 / Première Marche). Multi-guild server ranking. Extract player pseudo and fleet rating numerical power. Convert strings like "2.16M" -> 2160000, "1,850,000" -> 1850000, "2.26M" -> 2260000.`,
    tech: `Technology Power / Puissance Technologique (Alliance / Research Tech). Extract player pseudo and technology power integer. Convert strings like "15.4M" -> 15400000, "18,200,000" -> 18200000.`,
    flagship: `Strongest Flagship Power / Puissance Vaisseau Amiral. Multi-guild server ranking. Extract player pseudo and flagship power integer. Convert strings like "10.3M" -> 10300000, "9.8M" -> 9800000.`,
    champs: `Champion Total Power / Puissance Totale des Champions (Heroes / Héros). Multi-guild server ranking. Extract player pseudo and champion total power integer. Convert strings like "32.5M" -> 32500000, "28.4M" -> 28400000.`,
    crew: `Crew Total Power / Puissance Totale de l'Équipage (Foundation Officers). Multi-guild server ranking. Extract player pseudo and crew total power integer. Convert strings like "5.1M" -> 5100000, "4.8M" -> 4800000.`,
    glory: `Glory Score / Points de Gloire (PvP & Weekly Glory ranking). Extract player pseudo and cumulative Glory points integer. Convert strings like "240M" -> 240000000, "496,000,000" -> 496000000, "50K" -> 50000.`,
    svs_prep: `Server vs Server (SvS) Day 1 to 5 Preparation Stage Score / Score Phase de Préparation SvS (Jours 1 à 5). Extract player pseudo and preparation score integer. Convert strings like "28.5M" -> 28500000, "1,200,000" -> 1200000. Target guild members with guild tag.`,
    svs_pvp: `Server vs Server (SvS) Day 6 PvP Battle Score / Score Jour 6 PvP SvS. Extract player pseudo and Day 6 PvP score integer. Convert strings like "45.8M" -> 45800000, "3,450,000" -> 3450000. Target guild members with guild tag.`,
    gvg_prep: `Guild vs Guild (GvG) Day 1 to 5 Preparation Stage Score / Score Phase de Préparation GvG (Jours 1 à 5). Extract player pseudo and preparation score integer. Convert strings like "18.2M" -> 18200000, "950,000" -> 950000. Target guild members with guild tag.`,
    gvg_pvp: `Guild vs Guild (GvG) Day 6 PvP Battle Score / Score Jour 6 PvP GvG. Extract player pseudo and Day 6 PvP score integer. Convert strings like "35.1M" -> 35100000, "2,100,000" -> 2100000. Target guild members with guild tag.`,
    // Per-day grid metrics: {day} is substituted with the VALIDATED scanDay
    // integer below (never a raw, uncontrolled string).
    svs_day: `Server vs Server (SvS) Day {day} Preparation Score / Score Jour {day} Phase de Préparation SvS. Extract player pseudo and the preparation score for Day {day} only (per-day grid, not the cumulative total). Convert strings like "5.2M" -> 5200000, "850,000" -> 850000. Target guild members with guild tag.`,
    gvg_day: `Guild vs Guild (GvG) Day {day} Preparation Score / Score Jour {day} Phase de Préparation GvG. Extract player pseudo and the preparation score for Day {day} only (per-day grid, not the cumulative total). Convert strings like "4.8M" -> 4800000, "720,000" -> 720000. Target guild members with guild tag.`,
    shadowfront_s1: `Shadowfront Squad 1 Battle / Composition Roster (Escouade 1). Extract all visible player usernames (pseudos) participating or listed in Squad 1 main squad or reserve substitutes.`,
    shadowfront_s2: `Shadowfront Squad 2 Battle / Composition Roster (Escouade 2). Extract all visible player usernames (pseudos) participating or listed in Squad 2 main squad or reserve substitutes.`,
    dtr: `Defend Trade Route (DTR) / Défense de la Route Commerciale. Extract all player usernames (pseudos) and their score/points. If score is explicitly 0 or 0 pts, output score as 0; if score > 0, output positive integer score.`,
    armsrace_sa: `Arms Race Stage A / Course aux Armements Étape A. Extract all visible player usernames (pseudos) participating or present in Stage A.`,
    armsrace_sb: `Arms Race Stage B / Course aux Armements Étape B. Extract all visible player usernames (pseudos) participating or present in Stage B.`
  };

  const targetMetricDesc = metricInstructions[metricType] || metricInstructions.power;

  // Substitution is only allowed for the two per-day war metrics, using the
  // Zod-validated integer (never raw text). Any other metric keeps its prompt.
  let resolvedMetricDesc = targetMetricDesc;
  if ((metricType === "svs_day" || metricType === "gvg_day") && scanDay !== undefined) {
    resolvedMetricDesc = targetMetricDesc.replace("{day}", String(scanDay));
  }

  const taskMetadata = {
    metric: metricType,
    metric_description: resolvedMetricDesc,
    guild_tag: guildTag || null,
    rank_hint: rankHint || null,
    scan_day: scanDay || null,
    is_multi_guild: isMultiGuild,
    is_members_roster: isMembersRoster,
  };

  const parts: any[] = [
    {
      text: `[EXTRACTION TASK METADATA - ISOLATED INPUT]\n${JSON.stringify(taskMetadata, null, 2)}\n\nExtract all visible player rows for this metric from the following image(s).`,
    },
  ];

  if (imagesArray.length > 0) {
    for (const item of imagesArray) {
      let b64 = item.base64Data || "";
      let mType = item.mimeType || "image/png";
      if (b64.includes(";base64,")) {
        const p = b64.split(";base64,");
        if (p[0].includes("image/")) {
          mType = p[0].split("image/")[1].split(";")[0];
          mType = `image/${mType}`;
        }
        b64 = p[1];
      }
      if (b64) {
        parts.push({
          inline_data: {
            mime_type: mType,
            data: b64,
          },
        });
      }
    }
  } else {
    // Strip data URL header if present (e.g. data:image/png;base64,...)
    if (imageBase64.includes(";base64,")) {
      const p = imageBase64.split(";base64,");
      if (p[0].includes("image/")) {
        mimeType = p[0].split("image/")[1].split(";")[0];
        mimeType = `image/${mimeType}`;
      }
      imageBase64 = p[1];
    }
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: imageBase64,
      },
    });
  }

  const responseSchema = {
    type: "OBJECT",
    properties: {
      metric: { type: "STRING" },
      guild_tag: { type: "STRING", nullable: true },
      players: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            pseudo: { type: "STRING" },
            guild_tag: { type: "STRING", nullable: true },
            score: { type: "NUMBER" },
            raw_score: { type: "STRING", nullable: true },
            uid: { type: "STRING", nullable: true },
            rank: { type: "STRING", nullable: true },
          },
          required: ["pseudo", "score"],
        },
      },
      endingRank: { type: "STRING", nullable: true },
    },
    required: ["metric", "players"],
  };

  const promptPayload = {
    system_instruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [{ parts }],
    generationConfig: {
      response_mime_type: "application/json",
      response_schema: responseSchema,
      temperature: 0.1,
      max_output_tokens: 8192,
    },
  };

  // B1: one shared list; three of the five entries here were identifiers
  // Google has never published. See _shared/gemini.ts.
  const modelsToTry = GEMINI_MODEL_FALLBACKS;

  let geminiResultRaw = "";
  let lastError = "";

  logger.info("Initiating Gemini OCR scan", { imageCount: imagesArray.length || 1 });

  for (const modelName of modelsToTry) {
    try {
      const apiUrl = geminiGenerateContentUrl(modelName);
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
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
        const pseudo = String(p.pseudo || p.name || p.username || "").trim();
        const rawScore = p.score != null ? p.score : (p.overall_power != null ? p.overall_power : (p.power != null ? p.power : 0));
        const rawText = p.raw_score != null ? String(p.raw_score).trim() : (typeof rawScore === "string" ? rawScore : null);
        const val = parseOcrScore(rawScore, rawText);
        const uid = p.uid ? String(p.uid).trim() : null;
        const result: Record<string, unknown> = {
          pseudo,
          score: Math.max(0, val),
          overall_power: Math.max(0, val),
          raw_score: rawText || (typeof rawScore === "string" ? rawScore : String(val)),
          uid
        };
        if (isMembersRoster) {
          const rawRank = typeof p.rank === "string" ? p.rank.trim().toUpperCase() : null;
          result.rank = rawRank && VALID_RANKS_SET.has(rawRank) ? rawRank : null;
        }
        return result;
      })
      .filter((p: any) => p.pseudo.length > 0 && p.score >= 0);

    let endingRank: string | null = null;
    if (isMembersRoster) {
      const rawEnding = typeof parsed?.endingRank === "string" ? parsed.endingRank.trim().toUpperCase() : null;
      endingRank = rawEnding && VALID_RANKS_SET.has(rawEnding) ? rawEnding : null;
    }

    logger.info("OCR Extraction completed", { detectedCount: players.length, metricType, endingRank });

    // Persist to cache (best-effort, non-blocking)
    try {
      await admin.from("ocr_cache").upsert({
        hash: cacheKey,
        guild_id: caller.guild || null,
        metric_type: metricType,
        players,
        ending_rank: endingRank,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      logger.info("OCR result cached successfully", { hash: cacheKey });
    } catch (cacheWriteErr: any) {
      logger.warn("Failed to write OCR result to cache", { error: cacheWriteErr?.message });
    }

    return json({ ok: true, metricType, players, count: players.length, endingRank, cached: false });
  } catch (e: any) {
    logger.error("Failed to parse Gemini OCR JSON response", e, { raw: geminiResultRaw });
    return json(
      { ok: false, error: "json_parse_failed", raw: geminiResultRaw },
      500
    );
  }
});
