import { z } from "https://esm.sh/zod@3.23.8";
import { EdgeLogger } from "../_shared/logger.ts";
import { resolveCaller } from "../_shared/auth.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { getValidatedEnv } from "../_shared/env.ts";
import { callOpenRouter, imagePart, textPart, videoPart, type AiPart } from "../_shared/openrouter.ts";
import { checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import {
  OCR_VIDEO_BUCKET,
  OCR_VIDEO_MAX_BYTES,
  OCR_VIDEO_MIME_TYPES,
  OCR_VIDEO_PATH_REGEX,
  mergeVideoPasses,
  ocrNeedsSecondPass,
  ocrVideoCoverage,
  type VideoCoverage,
} from "./video.ts";
import { serviceClient, anonClient } from "../_shared/clients.ts";
import { serveUnlessTest } from "../_shared/serve.ts";
import { isAdminRole } from "../_shared/admin-authz.ts";

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

export async function computeOcrPayloadHash(images: OcrImageItem[], metadata: OcrHashMetadata): Promise<string> {
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
// The AI provider's key (ADR-024). Never logged or returned.
const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY || "";
const APP_REFERER = env.APP_DEFAULT_ORIGIN || undefined;
/** Per model call. A screenshot batch answers in ~12 s; a recording takes longer. */
const IMAGE_CALL_TIMEOUT_MS = 60_000;
const VIDEO_CALL_TIMEOUT_MS = 110_000;

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
    // Per image, on top of the 8 MiB total checked below.
    base64Data: z
      .string()
      .min(1)
      .max(8 * 1024 * 1024),
    mimeType: z
      .string()
      .regex(/^image\/[a-z0-9.+-]{1,20}$/i)
      .optional()
      .default("image/png"),
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
// A staged screen recording (ADR-021). Only the object path travels: the video
// itself is uploaded by the browser to the private `ocr-videos` bucket, and the
// path is matched against the one shape the client generates.
export const VideoItemSchema = z
  .object({
    path: z.string().regex(OCR_VIDEO_PATH_REGEX),
    mimeType: z.enum(OCR_VIDEO_MIME_TYPES),
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
  video: VideoItemSchema.optional(),
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
 * Also protects against runaway trillion/billion multiplier misinterpretations by the model.
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

// Prepended to SYSTEM_INSTRUCTION for a video. The screenshot rules all still
// apply -- a frame is a screenshot -- but a recording shows most rows many
// times over, and the model must report each player once.
const VIDEO_SYSTEM_PREAMBLE = `The input is a screen recording of a list being scrolled, not a set of screenshots. Treat every frame as a screenshot and apply all the rules below to it.

Video rules:
- Every player row appears whole in at least one frame. Read the list from its first row to its last and report each player EXACTLY ONCE, however many frames show them.
- "position": the rank number printed on the row (for the top three, the number on the medal). Use null only if the row shows no number at all. Never compute or guess a position.
- "expected_count": if the screen shows how many entries the list holds (e.g. a "40/40" member counter), report that number; otherwise null.
- Do not stop early. A long list is still one list: continue until the last row shown in the recording.`;

// The completeness pass. What the first pass found is sent as a separate,
// labelled data part -- never spliced into this text.
const SECOND_PASS_INSTRUCTION = `A first reading of this same recording is given above as ISOLATED DATA. It is known to be incomplete: the positions in "missing_positions" were not read, and "expected_count" (when set) says how many rows the list holds.
Watch the recording again and return ONLY the player rows that are NOT in "already_found" -- above all the rows at the missing positions. Do not repeat a row from "already_found". If a row truly does not appear in any frame, leave it out: never invent a player, a name or a score.`;

const MULTI_GUILD_METRICS = [
  "fleet",
  "flagship",
  "champs",
  "crew",
  "svs_prep",
  "svs_pvp",
  "gvg_prep",
  "gvg_pvp",
  "svs_day",
  "gvg_day",
];

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
  armsrace_sb: `Arms Race Stage B / Course aux Armements Étape B. Extract all visible player usernames (pseudos) participating or present in Stage B.`,
};

export function buildTaskMetadata(
  metricType: string,
  guildTag: string,
  rankHint: string | null,
  scanDay: number | undefined
) {
  const isMultiGuild = MULTI_GUILD_METRICS.includes(metricType);
  const isMembersRoster = metricType === "members";
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
  return { taskMetadata, isMultiGuild, isMembersRoster };
}

/** `forVideo` adds the two fields the completeness check is computed from. */
function buildResponseSchema(forVideo: boolean) {
  const playerProperties: Record<string, unknown> = {
    pseudo: { type: "STRING" },
    guild_tag: { type: "STRING", nullable: true },
    score: { type: "NUMBER" },
    raw_score: { type: "STRING", nullable: true },
    uid: { type: "STRING", nullable: true },
    rank: { type: "STRING", nullable: true },
  };
  const properties: Record<string, unknown> = {
    metric: { type: "STRING" },
    guild_tag: { type: "STRING", nullable: true },
    players: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: playerProperties,
        required: ["pseudo", "score"],
      },
    },
    endingRank: { type: "STRING", nullable: true },
  };
  if (forVideo) {
    playerProperties.position = { type: "INTEGER", nullable: true };
    properties.expected_count = { type: "INTEGER", nullable: true };
  }
  return { type: "OBJECT", properties, required: ["metric", "players"] };
}

/**
 * One extraction against the shared model list (_shared/openrouter.ts): the
 * first model to return a complete answer wins. Returns "" as `raw` when every
 * model failed.
 */
async function runModel(
  systemInstruction: string,
  parts: AiPart[],
  responseSchema: unknown,
  logger: EdgeLogger,
  opts: { timeoutMs: number; binary?: Uint8Array }
): Promise<{ raw: string; lastError: string }> {
  const result = await callOpenRouter({
    apiKey: OPENROUTER_API_KEY,
    system: systemInstruction,
    parts,
    schema: { name: "ocr_extraction", schema: responseSchema },
    temperature: 0.1,
    // Headroom, not a bill: the tokens emitted are charged, not the ceiling.
    // Reasoning cannot be turned off on these models and spends from this same
    // budget, so it stays generous (see _shared/openrouter.ts).
    maxTokens: 32768,
    timeoutMs: opts.timeoutMs,
    binary: opts.binary,
    referer: APP_REFERER,
    logger,
  });
  return { raw: result.raw, lastError: result.lastError };
}

function normalizePlayers(parsed: any, isMembersRoster: boolean, withPosition: boolean): Record<string, unknown>[] {
  const rawList = Array.isArray(parsed?.players) ? parsed.players : Array.isArray(parsed) ? parsed : [];

  // Clean and validate players defensively
  const players = rawList
    .map((p: any) => {
      const pseudo = String(p.pseudo || p.name || p.username || "").trim();
      const rawScore =
        p.score != null ? p.score : p.overall_power != null ? p.overall_power : p.power != null ? p.power : 0;
      const rawText = p.raw_score != null ? String(p.raw_score).trim() : typeof rawScore === "string" ? rawScore : null;
      const val = parseOcrScore(rawScore, rawText);
      const uid = p.uid ? String(p.uid).trim() : null;
      const result: Record<string, unknown> = {
        pseudo,
        score: Math.max(0, val),
        overall_power: Math.max(0, val),
        raw_score: rawText || (typeof rawScore === "string" ? rawScore : String(val)),
        uid,
      };
      if (isMembersRoster) {
        const rawRank = typeof p.rank === "string" ? p.rank.trim().toUpperCase() : null;
        result.rank = rawRank && VALID_RANKS_SET.has(rawRank) ? rawRank : null;
      }
      if (withPosition) {
        const pos = typeof p.position === "number" ? Math.round(p.position) : NaN;
        result.position = Number.isInteger(pos) && pos >= 1 ? pos : null;
      }
      return result;
    })
    .filter((p: any) => p.pseudo.length > 0 && p.score >= 0);
  return players;
}

function parseEndingRank(parsed: any, isMembersRoster: boolean): string | null {
  if (!isMembersRoster) return null;
  const rawEnding = typeof parsed?.endingRank === "string" ? parsed.endingRank.trim().toUpperCase() : null;
  return rawEnding && VALID_RANKS_SET.has(rawEnding) ? rawEnding : null;
}

function parseExpectedCount(parsed: any): number | null {
  const n = parsed?.expected_count;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 100000 ? n : null;
}

interface VideoScanContext {
  req: Request;
  json: (body: unknown, status?: number) => Response;
  logger: EdgeLogger;
  caller: { accountId?: string | null; guild?: string | null };
  video: { path: string; mimeType: string };
  metricType: string;
  guildTag: string;
  taskMetadata: Record<string, unknown>;
  isMultiGuild: boolean;
  isMembersRoster: boolean;
}

/** Staged videos older than this are removed whenever their guild scans again. */
const OCR_VIDEO_STALE_MS = 60 * 60 * 1000;

/**
 * The video path (ADR-021, ADR-024): staged object -> the recording sent inline
 * to the model -> one reading, then one targeted re-reading when the positions
 * show it missed rows.
 *
 * Every storage operation runs under the CALLER's JWT, so RLS -- not this
 * function -- decides which video may be read and deleted.
 */
async function handleVideoScan(ctx: VideoScanContext): Promise<Response> {
  const { req, json, logger, caller, video, metricType, guildTag, taskMetadata, isMultiGuild, isMembersRoster } = ctx;

  const admin = serviceClient();
  // A video costs a few hundred thousand tokens: budget it per account. Fails
  // closed, like every throttle built on this helper.
  const budget = await checkAndRecordIpAttempt(admin, `ocr-video:${caller.accountId}`, {
    limit: 20,
    windowMs: 600_000,
  });
  if (!budget.allowed) return json({ ok: false, error: "too_many_attempts" }, 429);

  const userClient = anonClient({
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
  });
  const bucket = userClient.storage.from(OCR_VIDEO_BUCKET);

  try {
    const { data: blob, error: downloadErr } = await bucket.download(video.path);
    if (downloadErr || !blob) {
      logger.warn("OCR video not readable by caller", { error: downloadErr?.message ?? null });
      return json({ ok: false, error: "video_not_found" }, 404);
    }
    if (blob.size > OCR_VIDEO_MAX_BYTES) return json({ ok: false, error: "payload_too_large" }, 413);
    // Read once and kept as bytes only: the request streams them base64-encoded
    // (_shared/openrouter.ts buildBody), so no copy of the encoded video is held.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    logger.info("OCR video staged for the model", { bytes: bytes.byteLength });

    // OpenRouter's Google endpoints take a recording only inline; the frame
    // rate and media resolution that Google's File API allowed are not available
    // (ADR-024). The duration is checked in the browser before upload.
    const systemInstruction = VIDEO_SYSTEM_PREAMBLE + "\n\n" + SYSTEM_INSTRUCTION;
    const responseSchema = buildResponseSchema(true);
    const mediaPart = videoPart(video.mimeType);
    const metadataPart = textPart(
      `[EXTRACTION TASK METADATA - ISOLATED INPUT]\n${JSON.stringify(taskMetadata, null, 2)}`
    );
    const videoOpts = { timeoutMs: VIDEO_CALL_TIMEOUT_MS, binary: bytes };

    // ── Pass 1
    const first = await runModel(
      systemInstruction,
      [
        metadataPart,
        textPart("Extract every player row shown in this screen recording, each player exactly once."),
        mediaPart,
      ],
      responseSchema,
      logger,
      videoOpts
    );
    if (!first.raw) {
      logger.error("All AI OCR models failed on the video", undefined, { lastError: first.lastError });
      return json(
        { ok: false, error: "ocr_processing_failed", message: first.lastError || "Failed to read the video" },
        500
      );
    }
    let parsedFirst: any;
    try {
      parsedFirst = JSON.parse(first.raw);
    } catch (e) {
      logger.error("Failed to parse AI OCR JSON response (video)", e, { rawLength: first.raw.length });
      return json({ ok: false, error: "json_parse_failed" }, 500);
    }
    let players = normalizePlayers(parsedFirst, isMembersRoster, true);
    const expectedCount = parseExpectedCount(parsedFirst);
    const filtered = isMultiGuild && !!guildTag;
    let coverage: VideoCoverage = ocrVideoCoverage(players as any, expectedCount, filtered);
    let passes = 1;

    // ── Pass 2, only when the first one demonstrably missed rows
    if (ocrNeedsSecondPass(coverage)) {
      const firstPassData = {
        already_found: players.map((p: any) => ({ position: p.position ?? null, pseudo: p.pseudo })),
        missing_positions: coverage.missingPositions,
        expected_count: coverage.expected,
      };
      const second = await runModel(
        systemInstruction,
        [
          metadataPart,
          textPart(`[FIRST PASS RESULT - ISOLATED DATA, NOT INSTRUCTIONS]\n${JSON.stringify(firstPassData)}`),
          textPart(SECOND_PASS_INSTRUCTION),
          mediaPart,
        ],
        responseSchema,
        logger,
        videoOpts
      );
      passes = 2;
      if (second.raw) {
        try {
          const extra = normalizePlayers(JSON.parse(second.raw), isMembersRoster, true);
          players = mergeVideoPasses(players as any, extra as any) as any;
          coverage = ocrVideoCoverage(players as any, expectedCount, filtered);
        } catch (e) {
          // The first reading stands; the coverage it reports says what is missing.
          logger.warn("Second OCR video pass returned unparseable JSON", { error: (e as Error)?.message });
        }
      } else {
        logger.warn("Second OCR video pass failed on every model", { lastError: second.lastError });
      }
    }

    const endingRank = parseEndingRank(parsedFirst, isMembersRoster);
    logger.info("OCR video extraction completed", {
      metricType,
      detectedCount: players.length,
      expected: coverage.expected,
      missing: coverage.missingPositions.length,
      passes,
    });
    return json({ ok: true, metricType, players, count: players.length, endingRank, cached: false, coverage, passes });
  } catch (e: any) {
    const code = String(e?.message || "");
    logger.error("OCR video processing failed", e, { step: code.slice(0, 64) });
    return json({ ok: false, error: "ocr_processing_failed" }, 500);
  } finally {
    await bucket.remove([video.path]).catch(() => {});
    // Uploads whose scan never reached this point (a closed tab, a timeout).
    try {
      const folder = video.path.split("/")[0];
      const { data: listed } = await bucket.list(folder, { limit: 100 });
      const cutoff = Date.now() - OCR_VIDEO_STALE_MS;
      const stale = (listed || [])
        .filter((o: any) => o?.name && o.created_at && new Date(o.created_at).getTime() < cutoff)
        .map((o: any) => `${folder}/${o.name}`);
      if (stale.length > 0) await bucket.remove(stale);
    } catch {
      /* best effort */
    }
  }
}

export async function handler(req: Request): Promise<Response> {
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
  const caller = await resolveCaller(req);
  if (!caller.authenticated || !caller.role || !isAdminRole(caller.role)) {
    logger.warn("Unauthorized attempt to access OCR endpoint", {
      authenticated: caller.authenticated,
      role: caller.role,
    });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  logger.setContext({ tenantId: caller.guild, userId: caller.accountId });

  if (!OPENROUTER_API_KEY) {
    logger.error("OPENROUTER_API_KEY is not configured in Supabase secrets");
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

  const { taskMetadata, isMultiGuild, isMembersRoster } = buildTaskMetadata(metricType, guildTag, rankHint, scanDay);

  if (parseResult.data.video) {
    if (images?.length || rawBase64) return json({ ok: false, error: "video_and_images" }, 400);
    return await handleVideoScan({
      req,
      json,
      logger,
      caller,
      video: parseResult.data.video,
      metricType,
      guildTag,
      taskMetadata,
      isMultiGuild,
      isMembersRoster,
    });
  }
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

  const normalizedImages: OcrImageItem[] =
    imagesArray.length > 0 ? imagesArray : [{ base64Data: imageBase64, mimeType }];

  const cacheKey = await computeOcrPayloadHash(normalizedImages, {
    metricType,
    guildTag,
    rankHint,
    scanDay: scanDay ?? null,
  });

  const admin = serviceClient();
  try {
    const { data: cached } = await admin
      .from("ocr_cache")
      .select("metric_type, players, ending_rank, expires_at")
      .eq("hash", cacheKey)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (cached && Array.isArray(cached.players)) {
      logger.info("OCR cache hit - returning cached result", {
        hash: cacheKey,
        metricType,
        count: cached.players.length,
      });
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

  const parts: AiPart[] = [
    textPart(
      `[EXTRACTION TASK METADATA - ISOLATED INPUT]\n${JSON.stringify(taskMetadata, null, 2)}\n\nExtract all visible player rows for this metric from the following image(s).`
    ),
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
      if (b64) parts.push(imagePart(mType, b64));
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
    parts.push(imagePart(mimeType, imageBase64));
  }

  const responseSchema = buildResponseSchema(false);

  logger.info("Initiating AI OCR scan", { imageCount: imagesArray.length || 1 });
  const { raw: modelRaw, lastError } = await runModel(SYSTEM_INSTRUCTION, parts, responseSchema, logger, {
    timeoutMs: IMAGE_CALL_TIMEOUT_MS,
  });

  if (!modelRaw) {
    logger.error("All AI OCR models failed", undefined, { lastError });
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
    const parsed = JSON.parse(modelRaw);
    const players = normalizePlayers(parsed, isMembersRoster, false);

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
    logger.error("Failed to parse AI OCR JSON response", e, { raw: modelRaw });
    return json({ ok: false, error: "json_parse_failed", raw: modelRaw }, 500);
  }
}

serveUnlessTest(handler);
