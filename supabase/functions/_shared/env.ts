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
  if (typeof Deno !== "undefined" && Deno.env && typeof Deno.env.toObject === "function") {
    return Deno.env.toObject();
  }
  if (typeof process !== "undefined" && process.env) {
    return process.env as Record<string, string | undefined>;
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
  source?: Record<string, unknown>,
  options?: EnvValidationOptions
): ValidatedEnv {
  const raw = source ?? getRawEnv();
  const schema = options?.requireGemini
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
