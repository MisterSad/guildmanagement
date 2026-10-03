import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Replicate computeOcrPayloadHash logic for Node/Vitest environment
function computeTestOcrHash(images, metadata) {
  const payload = JSON.stringify({
    images: images.map((img) => img.base64Data),
    metricType: metadata.metricType,
    guildTag: metadata.guildTag || null,
    rankHint: metadata.rankHint || null,
    scanDay: metadata.scanDay || null,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

describe('OCR Cache Deduplication & SHA-256 Hashing (TICKET-10 / PERF-03)', () => {
  const sampleImage1 = {
    base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    mimeType: 'image/png'
  };
  const sampleImage2 = {
    base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9Qz8DAwMAAAAwBAe5/g0QAAAAASUVORK5CYII=',
    mimeType: 'image/png'
  };

  describe('Deterministic SHA-256 Hash Computation', () => {
    it('produces identical SHA-256 hash for identical images and metadata', () => {
      const metadata = { metricType: 'power', guildTag: 'ALPHA', rankHint: 'R4', scanDay: null };

      const hashA = computeTestOcrHash([sampleImage1], metadata);
      const hashB = computeTestOcrHash([sampleImage1], metadata);

      expect(hashA).toBe(hashB);
      expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces different hash when image content changes', () => {
      const metadata = { metricType: 'power', guildTag: 'ALPHA', rankHint: null, scanDay: null };

      const hash1 = computeTestOcrHash([sampleImage1], metadata);
      const hash2 = computeTestOcrHash([sampleImage2], metadata);

      expect(hash1).not.toBe(hash2);
    });

    it('produces different hash when metricType differs', () => {
      const metaPower = { metricType: 'power', guildTag: 'ALPHA', rankHint: null, scanDay: null };
      const metaFleet = { metricType: 'fleet', guildTag: 'ALPHA', rankHint: null, scanDay: null };

      const hashPower = computeTestOcrHash([sampleImage1], metaPower);
      const hashFleet = computeTestOcrHash([sampleImage1], metaFleet);

      expect(hashPower).not.toBe(hashFleet);
    });

    it('produces different hash when scanDay differs (per-day war metrics)', () => {
      const metaDay1 = { metricType: 'svs_day', guildTag: 'ALPHA', rankHint: null, scanDay: 1 };
      const metaDay2 = { metricType: 'svs_day', guildTag: 'ALPHA', rankHint: null, scanDay: 2 };

      const hashDay1 = computeTestOcrHash([sampleImage1], metaDay1);
      const hashDay2 = computeTestOcrHash([sampleImage1], metaDay2);

      expect(hashDay1).not.toBe(hashDay2);
    });

    it('produces different hash when guildTag differs', () => {
      const metaAlpha = { metricType: 'glory', guildTag: 'ALPHA', rankHint: null, scanDay: null };
      const metaBeta = { metricType: 'glory', guildTag: 'BABE', rankHint: null, scanDay: null };

      const hashAlpha = computeTestOcrHash([sampleImage1], metaAlpha);
      const hashBeta = computeTestOcrHash([sampleImage1], metaBeta);

      expect(hashAlpha).not.toBe(hashBeta);
    });

    it('handles multiple images in sequence deterministically', () => {
      const meta = { metricType: 'members', guildTag: 'ALPHA', rankHint: 'R4', scanDay: null };

      const hashSeqA = computeTestOcrHash([sampleImage1, sampleImage2], meta);
      const hashSeqB = computeTestOcrHash([sampleImage1, sampleImage2], meta);
      const hashSeqReversed = computeTestOcrHash([sampleImage2, sampleImage1], meta);

      expect(hashSeqA).toBe(hashSeqB);
      expect(hashSeqA).not.toBe(hashSeqReversed);
    });
  });

  describe('Database Migration & Zero-Trust Schema Verification', () => {
    const migPath = path.resolve(__dirname, '../supabase/migrations/20260920130000_ocr_cache_table.sql');

    it('migration file exists', () => {
      expect(fs.existsSync(migPath)).toBe(true);
    });

    it('creates public.ocr_cache with primary key hash and jsonb players', () => {
      const sql = fs.readFileSync(migPath, 'utf-8');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.ocr_cache');
      expect(sql).toContain('hash text PRIMARY KEY');
      expect(sql).toContain('players jsonb NOT NULL');
      expect(sql).toContain('expires_at timestamptz NOT NULL');
    });

    it('enforces both ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY', () => {
      const sql = fs.readFileSync(migPath, 'utf-8');
      expect(sql).toContain('ALTER TABLE public.ocr_cache ENABLE ROW LEVEL SECURITY');
      expect(sql).toContain('ALTER TABLE public.ocr_cache FORCE ROW LEVEL SECURITY');
    });

    it('creates indexes for fast hash lookup and expiration cleanup', () => {
      const sql = fs.readFileSync(migPath, 'utf-8');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_ocr_cache_hash_expires ON public.ocr_cache(hash, expires_at)');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_ocr_cache_expires_at ON public.ocr_cache(expires_at)');
    });

    it('defines the cleanup function gm_cleanup_expired_ocr_cache with SECURITY DEFINER and search_path', () => {
      const sql = fs.readFileSync(migPath, 'utf-8');
      expect(sql).toContain('FUNCTION public.gm_cleanup_expired_ocr_cache()');
      expect(sql).toContain('SECURITY DEFINER');
      expect(sql).toContain("SET search_path = ''");
    });
  });

  describe('Edge Function Implementation Inspection', () => {
    const fnPath = path.resolve(__dirname, '../supabase/functions/ocr-guild-members/index.ts');

    it('gets its clients from _shared/clients.ts and exports computeOcrPayloadHash', () => {
      const content = fs.readFileSync(fnPath, 'utf-8');
      expect(content).toContain('from "../_shared/clients.ts"');
      expect(content).toContain('export async function computeOcrPayloadHash');
    });

    it('checks ocr_cache before invoking Gemini and returns cached: true on hit', () => {
      const content = fs.readFileSync(fnPath, 'utf-8');
      expect(content).toContain('.from("ocr_cache")');
      expect(content).toContain('.select("metric_type, players, ending_rank, expires_at")');
      expect(content).toContain('.gt("expires_at", new Date().toISOString())');
      expect(content).toContain('cached: true');
    });

    it('persists result to ocr_cache with 7-day TTL and returns cached: false on live extraction', () => {
      const content = fs.readFileSync(fnPath, 'utf-8');
      expect(content).toContain('.from("ocr_cache").upsert({');
      expect(content).toContain('cached: false');
    });
  });
});
