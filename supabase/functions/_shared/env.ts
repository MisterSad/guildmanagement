import { z } from "https://esm.sh/zod@3.23.8";

export class ConfigurationError extends Error {
  constructor(message: string, public issues?: z.ZodIssue[]) {
    super(message);
    this.name = "ConfigurationError";
  }
}

// Base schema for standard Supabase Deno Edge Functions
export const EnvSchema = z.object({
  SUPABASE_URL: z
    .string({ required_error: "SUPABASE_URL is required" })
    .url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string({ required_error: "SUPABASE_SERVICE_ROLE_KEY is required" })
    .min(1, "SUPABASE_SERVICE_ROLE_KEY must not be empty"),
  SUPABASE_ANON_KEY: z
    .string({ required_error: "SUPABASE_ANON_KEY is required" })
    .min(1, "SUPABASE_ANON_KEY must not be empty"),
  GEMINI_API_KEY: z.string().optional().default(""),
});

export type ValidatedEnv = z.infer<typeof EnvSchema>;

export interface EnvValidationOptions {
  requireGemini?: boolean;
}

function getRawEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (typeof Deno !== "undefined" && Deno.env) {
    if (typeof Deno.env.toObject === "function") {
      try {
        Object.assign(env, Deno.env.toObject());
      } catch {
        // Deno permissions or runtime may restrict toObject()
      }
    }
    const explicitKeys = [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_ANON_KEY",
      "GEMINI_API_KEY",
      "CRON_SECRET",
      "DISCORD_BOT_TOKEN",
      "DISCORD_APPLICATION_ID",
      "DISCORD_PUBLIC_KEY",
      "DISCORD_WORKER_SECRET",
      "DISCORD_CLIENT_ID",
      "DISCORD_CLIENT_SECRET",
      "DISCORD_OAUTH_REDIRECT_URI",
      "APP_DEFAULT_ORIGIN",
    ];
    for (const key of explicitKeys) {
      if (!env[key]) {
        try {
          const val = Deno.env.get(key);
          if (val !== undefined) env[key] = val;
        } catch {
          // ignore permission errors
        }
      }
    }
    return env;
  }
  // Node (vitest): read through globalThis so the Deno type-check needs no Node types.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc?.env) {
    return proc.env;
  }
  return {};
}

/**
 * Validates and returns execution environment variables according to the Zod schema.
 * Throws a ConfigurationError immediately if any required variable is missing or invalid.
 *
 * @param source Optional dictionary of environment variables to parse (defaults to Deno.env / process.env).
 * @param options Optional validation options (e.g., requireGemini to enforce non-empty GEMINI_API_KEY).
 */
export function getValidatedEnv(
  sourceOrOptions?: Record<string, unknown> | EnvValidationOptions,
  options?: EnvValidationOptions
): ValidatedEnv {
  let source: Record<string, unknown> | undefined;
  let opts: EnvValidationOptions | undefined = options;

  if (sourceOrOptions && typeof sourceOrOptions === "object") {
    if ("requireGemini" in sourceOrOptions && !("SUPABASE_URL" in sourceOrOptions)) {
      opts = sourceOrOptions as EnvValidationOptions;
      source = undefined;
    } else {
      source = sourceOrOptions as Record<string, unknown>;
    }
  }

  const raw = source ?? getRawEnv();
  const schema = opts?.requireGemini
    ? EnvSchema.extend({
        GEMINI_API_KEY: z
          .string({ required_error: "GEMINI_API_KEY is required" })
          .min(1, "GEMINI_API_KEY must not be empty"),
      })
    : EnvSchema;

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((i) => `[${i.path.join(".")}] ${i.message}`)
      .join("; ");
    throw new ConfigurationError(
      `Environment configuration error: ${errorDetails}`,
      parsed.error.issues
    );
  }

  return parsed.data;
}
