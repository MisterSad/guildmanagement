import { describe, it, expect } from 'vitest';
import { edgeSource } from './helpers/edge-source.js';
import { z } from 'zod';
import {
  MAX_ALLOWED_POWER,
  MAX_ALLOWED_EVENT_SCORE,
  parseSafeScore,
} from '../supabase/functions/_shared/player-actions.ts';

const portalContent = edgeSource('member-portal');

// Schemas matching the definitions in supabase/functions/member-portal/index.ts
export const RequestBodySchema = z.object({
  action: z.string().trim().min(1, "action is required"),
  payload: z.unknown().optional(),
});

export const SubmitScoresSchema = z.object({
  event_name: z.string().trim().min(1, "event_name is required").max(64),
  session_id: z.string().trim().min(1, "session_id is required").max(64),
  participated: z.union([z.boolean(), z.number()]).optional(),
  score: z.union([
    z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
    z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/).refine((val) => {
      const parsed = parseSafeScore(val);
      return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
    }, { message: `Score must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` })
  ]).optional(),
  score_prep: z.union([
    z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
    z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/).refine((val) => {
      const parsed = parseSafeScore(val);
      return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
    }, { message: `Score prep must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` })
  ]).optional(),
  score_pvp: z.union([
    z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
    z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/).refine((val) => {
      const parsed = parseSafeScore(val);
      return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
    }, { message: `Score pvp must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` })
  ]).optional(),
  late: z.union([z.boolean(), z.number()]).optional(),
}).passthrough();

export const UpdatePowerSchema = z.object({
  power: z.union([
    z.number().min(0).max(MAX_ALLOWED_POWER),
    z.string().regex(/^\s*\d+\s*$/)
  ]).refine((val) => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 && n <= MAX_ALLOWED_POWER;
  }, { message: `Power must be between 0 and ${MAX_ALLOWED_POWER}` })
}).passthrough();

const metricPowerField = z.union([
  z.number().min(0).max(MAX_ALLOWED_POWER),
  z.string().regex(/^\s*\d+\s*$/)
]).refine((val) => {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 && n <= MAX_ALLOWED_POWER;
}, { message: `Power metric must be between 0 and ${MAX_ALLOWED_POWER}` }).optional();

const metricGloryField = z.union([
  z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
  z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/)
]).refine((val) => {
  const parsed = parseSafeScore(val);
  return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
}, { message: `Glory metric must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` }).optional();

export const UpdateMetricsSchema = z.object({
  total_power: metricPowerField,
  power: metricPowerField,
  tech_power: metricPowerField,
  champion_power: metricPowerField,
  crew_power: metricPowerField,
  flagship_power: metricPowerField,
  fleet_rating: metricPowerField,
  glory_score: metricGloryField,
}).passthrough();

export const GetMetricsHistorySchema = z.object({
  limit: z.union([
    z.number().int().min(1).max(100),
    z.string().regex(/^\d+$/).transform(v => parseInt(v, 10))
  ]).optional(),
}).passthrough();

export const UpdateGlorySchema = z.object({
  glory: z.union([
    z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
    z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/)
  ]).refine((val) => {
    const parsed = parseSafeScore(val);
    return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
  }, { message: `Glory score must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` })
}).passthrough();

export const SubmitTransferRequestSchema = z.object({
  targetGuild: z.string().trim().min(1, "targetGuild is required").max(32)
}).passthrough();

export const SetAbsenceSchema = z.object({
  start_date: z.string().trim().min(1, "start_date is required").max(32),
  end_date: z.string().trim().min(1, "end_date is required").max(32),
  kind: z.enum(["full", "partial", "war", "prep", "svs"]).optional().default("full"),
  note: z.string().trim().max(500).optional().default(""),
  id: z.string().trim().max(64).nullish(),
}).passthrough();

export const DeleteAbsenceSchema = z.object({
  id: z.string().trim().min(1, "id is required").max(64)
}).passthrough();

const isQuarterHourOffset = (v) => Number.isFinite(v) && v >= -12 && v <= 14 && Number.isInteger(v * 4);

export const UpdateTimezoneSchema = z.object({
  offset: z.union([
    z.number().refine(isQuarterHourOffset, { message: "Offset must be between -12 and 14, in quarter hours" }),
    z.string().regex(/^-?\d+(\.\d+)?$/).transform(v => Number(v))
      .refine(isQuarterHourOffset, { message: "Offset must be between -12 and 14, in quarter hours" })
  ])
}).passthrough();

export const ActionPayloadSchemas = {
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

describe('Ticket 2.3: Static Containment - Zod Schema Validation in member-portal', () => {
  it('imports Zod from the official esm.sh CDN URL', () => {
    expect(portalContent).toContain('import { z } from "https://esm.sh/zod@3.23.8";');
  });

  it('defines and exports all required action schemas and ActionPayloadSchemas registry', () => {
    expect(portalContent).toContain('export const RequestBodySchema =');
    expect(portalContent).toContain('export const SubmitScoresSchema =');
    expect(portalContent).toContain('export const UpdatePowerSchema =');
    expect(portalContent).toContain('export const UpdateMetricsSchema =');
    expect(portalContent).toContain('export const GetMetricsHistorySchema =');
    expect(portalContent).toContain('export const UpdateGlorySchema =');
    expect(portalContent).toContain('export const SubmitTransferRequestSchema =');
    expect(portalContent).toContain('export const SetAbsenceSchema =');
    expect(portalContent).toContain('export const DeleteAbsenceSchema =');
    expect(portalContent).toContain('export const UpdateTimezoneSchema =');
    expect(portalContent).toContain('Number.isInteger(v * 4)');
    // Removed with /link on 2026-10-03.
    expect(portalContent).not.toContain('ConfirmDiscordLinkSchema');
    // Web Push was removed with the PWA: the schema and both push-prefs
    // actions are gone from member-portal, and must not come back.
    expect(portalContent).not.toContain('SetPushPrefsSchema');
    expect(portalContent).not.toContain('push-prefs');
    expect(portalContent).not.toContain('CreateDonationSchema');
    expect(portalContent).toContain('export const ActionPayloadSchemas: Record<string, z.ZodType<any>> =');
  });

  it('validates request body and returns HTTP 422 with invalid_payload on schema mismatch', () => {
    expect(portalContent).toContain('error: "invalid_payload"');
    expect(portalContent).toContain('422');
    expect(portalContent).toContain('issues: payloadParsed.error.issues');
  });

  it('validates action presence and returns HTTP 400 on missing or invalid action', () => {
    expect(portalContent).toContain('error: hasAction ? "bad_request" : "missing_action"');
    expect(portalContent).toContain('error: "bad_request" }, 400');
  });

  it('preserves essential security and audit logic', () => {
    expect(portalContent).toContain('parseSafeScore(payload.score)');
    expect(portalContent).toContain('parseSafeScore(payload.score_prep)');
    expect(portalContent).toContain('parseSafeScore(payload.score_pvp)');
    expect(portalContent).not.toContain('update.excused = !!payload.excused');
    expect(portalContent).not.toContain('update.appointed = !!payload.appointed');
    expect(portalContent).not.toMatch(/account_id:\s*payload/);
  });
});

describe('Ticket 2.3: Zod Schema Unit Validation', () => {
  describe('RequestBodySchema', () => {
    it('accepts valid request body with action and optional payload', () => {
      const valid1 = RequestBodySchema.safeParse({ action: 'get-active-sessions' });
      expect(valid1.success).toBe(true);

      const valid2 = RequestBodySchema.safeParse({
        action: 'submit-scores',
        payload: { event_name: 'SVS', session_id: 's1' },
      });
      expect(valid2.success).toBe(true);
    });

    it('rejects missing or empty action', () => {
      expect(RequestBodySchema.safeParse({}).success).toBe(false);
      expect(RequestBodySchema.safeParse({ action: '' }).success).toBe(false);
      expect(RequestBodySchema.safeParse({ action: '   ' }).success).toBe(false);
      expect(RequestBodySchema.safeParse({ action: 123 }).success).toBe(false);
    });
  });

  describe('SubmitScoresSchema', () => {
    it('accepts valid event scoring payload', () => {
      const parsed = SubmitScoresSchema.safeParse({
        event_name: 'Arms Race',
        session_id: 'session-001',
        score: 150000,
        score_prep: 50000,
        score_pvp: 100000,
        participated: true,
        late: false,
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects missing event_name or session_id', () => {
      expect(SubmitScoresSchema.safeParse({ session_id: 's1' }).success).toBe(false);
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS' }).success).toBe(false);
      expect(SubmitScoresSchema.safeParse({ event_name: '', session_id: 's1' }).success).toBe(false);
    });

    it('accepts scores above 500M up to the 9,999,999,999 bound', () => {
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS', session_id: 's1', score: 500_000_001 }).success).toBe(true);
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS', session_id: 's1', score_prep: 4_999_999_999 }).success).toBe(true);
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS', session_id: 's1', score_pvp: 9_999_999_999 }).success).toBe(true);
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS', session_id: 's1', score: '9,999,999,999' }).success).toBe(true);
    });

    it('rejects negative scores or scores exceeding the 9,999,999,999 bound', () => {
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS', session_id: 's1', score: -1 }).success).toBe(false);
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS', session_id: 's1', score: 10_000_000_000 }).success).toBe(false);
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS', session_id: 's1', score_prep: -10 }).success).toBe(false);
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS', session_id: 's1', score_pvp: 10_000_000_000 }).success).toBe(false);
    });

    it('rejects malformed string scores', () => {
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS', session_id: 's1', score: 'not-a-number' }).success).toBe(false);
      expect(SubmitScoresSchema.safeParse({ event_name: 'SVS', session_id: 's1', score: '-50' }).success).toBe(false);
    });
  });

  describe('UpdatePowerSchema', () => {
    it('accepts valid power values within 0..5B', () => {
      expect(UpdatePowerSchema.safeParse({ power: 0 }).success).toBe(true);
      expect(UpdatePowerSchema.safeParse({ power: 25_000_000 }).success).toBe(true);
      expect(UpdatePowerSchema.safeParse({ power: 5_000_000_000 }).success).toBe(true);
      expect(UpdatePowerSchema.safeParse({ power: '1000000' }).success).toBe(true);
    });

    it('rejects negative power or power exceeding max allowed bound', () => {
      expect(UpdatePowerSchema.safeParse({ power: -1 }).success).toBe(false);
      expect(UpdatePowerSchema.safeParse({ power: 5_000_000_001 }).success).toBe(false);
      expect(UpdatePowerSchema.safeParse({ power: 'not_a_number' }).success).toBe(false);
      expect(UpdatePowerSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('UpdateMetricsSchema', () => {
    it('accepts valid metrics breakdown', () => {
      const valid = UpdateMetricsSchema.safeParse({
        total_power: 10_000_000,
        tech_power: 2_000_000,
        champion_power: 3_000_000,
        crew_power: 1_000_000,
        flagship_power: 1_500_000,
        fleet_rating: 500_000,
        glory_score: 450_000,
      });
      expect(valid.success).toBe(true);
    });

    it('accepts partial metrics breakdown', () => {
      expect(UpdateMetricsSchema.safeParse({}).success).toBe(true);
      expect(UpdateMetricsSchema.safeParse({ total_power: 5000 }).success).toBe(true);
    });

    it('accepts glory metrics above 500M up to the 9,999,999,999 bound', () => {
      expect(UpdateMetricsSchema.safeParse({ glory_score: 500_000_001 }).success).toBe(true);
      expect(UpdateMetricsSchema.safeParse({ glory_score: 9_999_999_999 }).success).toBe(true);
    });

    it('rejects out of bounds metrics', () => {
      expect(UpdateMetricsSchema.safeParse({ total_power: -5 }).success).toBe(false);
      expect(UpdateMetricsSchema.safeParse({ tech_power: 6_000_000_000 }).success).toBe(false);
      expect(UpdateMetricsSchema.safeParse({ glory_score: -1 }).success).toBe(false);
      expect(UpdateMetricsSchema.safeParse({ glory_score: 10_000_000_000 }).success).toBe(false);
    });
  });

  describe('GetMetricsHistorySchema', () => {
    it('accepts valid limit between 1 and 100', () => {
      expect(GetMetricsHistorySchema.safeParse({ limit: 12 }).success).toBe(true);
      expect(GetMetricsHistorySchema.safeParse({ limit: '24' }).success).toBe(true);
      expect(GetMetricsHistorySchema.safeParse({}).success).toBe(true);
    });

    it('rejects limit out of bounds', () => {
      expect(GetMetricsHistorySchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(GetMetricsHistorySchema.safeParse({ limit: -5 }).success).toBe(false);
      expect(GetMetricsHistorySchema.safeParse({ limit: 101 }).success).toBe(false);
    });
  });

  describe('UpdateGlorySchema', () => {
    it('accepts valid glory scores', () => {
      expect(UpdateGlorySchema.safeParse({ glory: 0 }).success).toBe(true);
      expect(UpdateGlorySchema.safeParse({ glory: 500000 }).success).toBe(true);
      expect(UpdateGlorySchema.safeParse({ glory: 500_000_000 }).success).toBe(true);
      expect(UpdateGlorySchema.safeParse({ glory: 9_999_999_999 }).success).toBe(true);
      expect(UpdateGlorySchema.safeParse({ glory: '150,000' }).success).toBe(true);
    });

    it('rejects invalid or out of bound glory scores', () => {
      expect(UpdateGlorySchema.safeParse({ glory: -1 }).success).toBe(false);
      expect(UpdateGlorySchema.safeParse({ glory: 10_000_000_000 }).success).toBe(false);
      expect(UpdateGlorySchema.safeParse({ glory: 'invalid' }).success).toBe(false);
      expect(UpdateGlorySchema.safeParse({}).success).toBe(false);
    });
  });

  describe('SubmitTransferRequestSchema', () => {
    it('accepts valid targetGuild', () => {
      expect(SubmitTransferRequestSchema.safeParse({ targetGuild: 'BABE' }).success).toBe(true);
    });

    it('rejects empty or missing targetGuild', () => {
      expect(SubmitTransferRequestSchema.safeParse({}).success).toBe(false);
      expect(SubmitTransferRequestSchema.safeParse({ targetGuild: '' }).success).toBe(false);
      expect(SubmitTransferRequestSchema.safeParse({ targetGuild: '   ' }).success).toBe(false);
    });
  });

  describe('SetAbsenceSchema', () => {
    it('accepts valid absence dates and kind', () => {
      expect(SetAbsenceSchema.safeParse({
        start_date: '2026-09-10',
        end_date: '2026-09-15',
        kind: 'full',
        note: 'Vacation',
      }).success).toBe(true);

      expect(SetAbsenceSchema.safeParse({
        start_date: '2026-09-10',
        end_date: '2026-09-15',
      }).success).toBe(true);
    });

    it('rejects missing dates or invalid kinds', () => {
      expect(SetAbsenceSchema.safeParse({ end_date: '2026-09-15' }).success).toBe(false);
      expect(SetAbsenceSchema.safeParse({ start_date: '2026-09-10' }).success).toBe(false);
      expect(SetAbsenceSchema.safeParse({
        start_date: '2026-09-10',
        end_date: '2026-09-15',
        kind: 'holiday',
      }).success).toBe(false);
    });
  });

  describe('DeleteAbsenceSchema', () => {
    it('accepts valid id', () => {
      expect(DeleteAbsenceSchema.safeParse({ id: 'abs-123' }).success).toBe(true);
    });

    it('rejects missing or empty id', () => {
      expect(DeleteAbsenceSchema.safeParse({}).success).toBe(false);
      expect(DeleteAbsenceSchema.safeParse({ id: '' }).success).toBe(false);
    });
  });

  describe('UpdateTimezoneSchema', () => {
    it('accepts valid timezone offset in hours (-12..14)', () => {
      expect(UpdateTimezoneSchema.safeParse({ offset: 0 }).success).toBe(true);
      expect(UpdateTimezoneSchema.safeParse({ offset: 2 }).success).toBe(true);
      expect(UpdateTimezoneSchema.safeParse({ offset: -8 }).success).toBe(true);
      expect(UpdateTimezoneSchema.safeParse({ offset: 14 }).success).toBe(true);
      expect(UpdateTimezoneSchema.safeParse({ offset: -12 }).success).toBe(true);
      expect(UpdateTimezoneSchema.safeParse({ offset: '5' }).success).toBe(true);
      // TICKET-0010: half- and quarter-hour zones (Adelaide, India, Nepal).
      expect(UpdateTimezoneSchema.safeParse({ offset: 9.5 }).success).toBe(true);
      expect(UpdateTimezoneSchema.safeParse({ offset: 5.75 }).success).toBe(true);
      expect(UpdateTimezoneSchema.safeParse({ offset: '10.5' }).success).toBe(true);
    });

    it('rejects offset out of bounds', () => {
      expect(UpdateTimezoneSchema.safeParse({ offset: 15 }).success).toBe(false);
      expect(UpdateTimezoneSchema.safeParse({ offset: -13 }).success).toBe(false);
      expect(UpdateTimezoneSchema.safeParse({ offset: 'abc' }).success).toBe(false);
      expect(UpdateTimezoneSchema.safeParse({ offset: 9.4 }).success).toBe(false);
      expect(UpdateTimezoneSchema.safeParse({}).success).toBe(false);
    });
  });

});

describe('Ticket 2.3: Validation Dispatch Simulation', () => {
  function simulatePortalRequest(rawBody) {
    const bodyParsed = RequestBodySchema.safeParse(rawBody);
    if (!bodyParsed.success) {
      const hasAction = typeof rawBody?.action === 'string' && rawBody.action.trim().length > 0;
      return { status: 400, body: { ok: false, error: hasAction ? 'bad_request' : 'missing_action', issues: bodyParsed.error.issues } };
    }

    const action = bodyParsed.data.action;
    let payload = (bodyParsed.data.payload && typeof bodyParsed.data.payload === 'object') ? bodyParsed.data.payload : {};

    const schema = ActionPayloadSchemas[action];
    if (schema) {
      const payloadParsed = schema.safeParse(payload);
      if (!payloadParsed.success) {
        return { status: 422, body: { ok: false, error: 'invalid_payload', issues: payloadParsed.error.issues } };
      }
      payload = payloadParsed.data;
    }

    return { status: 200, action, payload };
  }

  it('returns HTTP 400 missing_action when action is missing', () => {
    const res = simulatePortalRequest({ payload: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_action');
  });

  it('returns HTTP 422 invalid_payload when payload fails Zod validation', () => {
    // 1. update-power with negative value
    const res1 = simulatePortalRequest({ action: 'update-power', payload: { power: -50 } });
    expect(res1.status).toBe(422);
    expect(res1.body.error).toBe('invalid_payload');
    expect(res1.body.issues).toBeDefined();
    expect(res1.body.issues.length).toBeGreaterThanOrEqual(1);

    // 2. submit-scores with missing required fields
    const res2 = simulatePortalRequest({ action: 'submit-scores', payload: { score: 100 } });
    expect(res2.status).toBe(422);
    expect(res2.body.error).toBe('invalid_payload');

    // 3. set-absence with invalid kind
    const res3 = simulatePortalRequest({
      action: 'set-absence',
      payload: { start_date: '2026-09-01', end_date: '2026-09-05', kind: 'invalid_kind' },
    });
    expect(res3.status).toBe(422);
    expect(res3.body.error).toBe('invalid_payload');

    // 4. update-timezone with out of bounds offset
    const res4 = simulatePortalRequest({ action: 'update-timezone', payload: { offset: 99 } });
    expect(res4.status).toBe(422);
    expect(res4.body.error).toBe('invalid_payload');
  });

  it('returns HTTP 200 with parsed payload for valid requests', () => {
    const res = simulatePortalRequest({
      action: 'update-power',
      payload: { power: 1250000 },
    });
    expect(res.status).toBe(200);
    expect(res.action).toBe('update-power');
    expect(res.payload.power).toBe(1250000);
  });
});
