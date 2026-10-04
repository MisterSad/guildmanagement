/**
 * supabase/functions/member-portal/schemas.ts
 *
 * Zod schemas for the request envelope and for every action that takes a
 * payload (AGENTS.md rule 3). An action absent from ActionPayloadSchemas
 * takes no payload.
 */

import { z } from "https://esm.sh/zod@3.23.8";
import { MAX_ALLOWED_POWER, MAX_ALLOWED_EVENT_SCORE, parseSafeScore } from "../_shared/player-actions.ts";

// --- Zod Request and Action Payload Schemas ---

export const RequestBodySchema = z.object({
  action: z.string().trim().min(1, "action is required"),
  payload: z.unknown().optional(),
});

export const SubmitScoresSchema = z
  .object({
    event_name: z.string().trim().min(1, "event_name is required").max(64),
    session_id: z.string().trim().min(1, "session_id is required").max(64),
    participated: z.union([z.boolean(), z.number()]).optional(),
    score: z
      .union([
        z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
        z
          .string()
          .regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/)
          .refine(
            (val) => {
              const parsed = parseSafeScore(val);
              return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
            },
            { message: `Score must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` }
          ),
      ])
      .optional(),
    score_prep: z
      .union([
        z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
        z
          .string()
          .regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/)
          .refine(
            (val) => {
              const parsed = parseSafeScore(val);
              return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
            },
            { message: `Score prep must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` }
          ),
      ])
      .optional(),
    score_pvp: z
      .union([
        z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
        z
          .string()
          .regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/)
          .refine(
            (val) => {
              const parsed = parseSafeScore(val);
              return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
            },
            { message: `Score pvp must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` }
          ),
      ])
      .optional(),
    late: z.union([z.boolean(), z.number()]).optional(),
  })
  .passthrough();

export const UpdatePowerSchema = z
  .object({
    power: z.union([z.number().min(0).max(MAX_ALLOWED_POWER), z.string().regex(/^\s*\d+\s*$/)]).refine(
      (val) => {
        const n = Number(val);
        return Number.isFinite(n) && n >= 0 && n <= MAX_ALLOWED_POWER;
      },
      { message: `Power must be between 0 and ${MAX_ALLOWED_POWER}` }
    ),
  })
  .passthrough();

const metricPowerField = z
  .union([z.number().min(0).max(MAX_ALLOWED_POWER), z.string().regex(/^\s*\d+\s*$/)])
  .refine(
    (val) => {
      const n = Number(val);
      return Number.isFinite(n) && n >= 0 && n <= MAX_ALLOWED_POWER;
    },
    { message: `Power metric must be between 0 and ${MAX_ALLOWED_POWER}` }
  )
  .optional();

const metricGloryField = z
  .union([z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE), z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/)])
  .refine(
    (val) => {
      const parsed = parseSafeScore(val);
      return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
    },
    { message: `Glory metric must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` }
  )
  .optional();

export const UpdateMetricsSchema = z
  .object({
    total_power: metricPowerField,
    power: metricPowerField,
    tech_power: metricPowerField,
    champion_power: metricPowerField,
    crew_power: metricPowerField,
    flagship_power: metricPowerField,
    fleet_rating: metricPowerField,
    glory_score: metricGloryField,
  })
  .passthrough();

export const GetMetricsHistorySchema = z
  .object({
    limit: z
      .union([
        z.number().int().min(1).max(100),
        z
          .string()
          .regex(/^\d+$/)
          .transform((v) => parseInt(v, 10)),
      ])
      .optional(),
  })
  .passthrough();

export const UpdateGlorySchema = z
  .object({
    glory: z
      .union([z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE), z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/)])
      .refine(
        (val) => {
          const parsed = parseSafeScore(val);
          return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
        },
        { message: `Glory score must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` }
      ),
  })
  .passthrough();

export const SubmitTransferRequestSchema = z
  .object({
    targetGuild: z.string().trim().min(1, "targetGuild is required").max(32),
  })
  .passthrough();

export const SetAbsenceSchema = z
  .object({
    start_date: z.string().trim().min(1, "start_date is required").max(32),
    end_date: z.string().trim().min(1, "end_date is required").max(32),
    kind: z.enum(["full", "partial", "war", "prep", "svs"]).optional().default("full"),
    note: z.string().trim().max(500).optional().default(""),
    id: z.string().trim().max(64).nullish(),
  })
  .passthrough();

export const DeleteAbsenceSchema = z
  .object({
    id: z.string().trim().min(1, "id is required").max(64),
  })
  .passthrough();

// Offsets are hours in quarter-hour steps: Adelaide is +9.5, Kathmandu +5.75.
// `.int()` used to reject every half-hour zone the portal itself offers.
const isQuarterHourOffset = (v: number) => Number.isFinite(v) && v >= -12 && v <= 14 && Number.isInteger(v * 4);

export const UpdateTimezoneSchema = z
  .object({
    offset: z.union([
      z.number().refine(isQuarterHourOffset, { message: "Offset must be between -12 and 14, in quarter hours" }),
      z
        .string()
        .regex(/^-?\d+(\.\d+)?$/)
        .transform((v) => Number(v))
        .refine(isQuarterHourOffset, { message: "Offset must be between -12 and 14, in quarter hours" }),
    ]),
    timezone: z.string().trim().max(64).optional(),
  })
  .passthrough();

export const ActionPayloadSchemas: Record<string, z.ZodType<any>> = {
  "submit-scores": SubmitScoresSchema,
  "update-power": UpdatePowerSchema,
  "update-metrics": UpdateMetricsSchema,
  "get-metrics-history": GetMetricsHistorySchema,
  "update-glory": UpdateGlorySchema,
  "submit-transfer-request": SubmitTransferRequestSchema,
  "set-absence": SetAbsenceSchema,
  "delete-absence": DeleteAbsenceSchema,
  "update-timezone": UpdateTimezoneSchema,
};
