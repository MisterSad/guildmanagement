import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  GVG_CHEST_THRESHOLDS,
  SVS_CHEST_THRESHOLDS,
  defaultChestGrid,
  resolveChestsForScore,
} from '../src/core/scoring/chests';

describe('GvG & SvS 9-Tier Chests Scoring & Config', () => {
  const root = path.resolve(__dirname, '..');
  const indexHtml = fs.readFileSync(path.resolve(root, 'index.html'), 'utf-8');
  const migration = fs.readFileSync(path.resolve(root, 'supabase/migrations/20260915120000_widen_chest_tiers_limit.sql'), 'utf-8');

  describe('GvG Official Thresholds', () => {
    it('verifies Day 1 exact thresholds (9 tiers)', () => {
      expect(GVG_CHEST_THRESHOLDS[1]).toEqual([
        25000, 95400, 180000, 358000, 525000, 950000, 1450000, 2020000, 3200000
      ]);
    });

    it('verifies Day 2 to 4 exact thresholds (9 tiers)', () => {
      const expected = [76000, 306000, 536000, 612000, 1147500, 1532500, 2067000, 2757000, 3450000];
      expect(GVG_CHEST_THRESHOLDS[2]).toEqual(expected);
      expect(GVG_CHEST_THRESHOLDS[3]).toEqual(expected);
      expect(GVG_CHEST_THRESHOLDS[4]).toEqual(expected);
    });

    it('verifies Day 5 exact thresholds (9 tiers)', () => {
      expect(GVG_CHEST_THRESHOLDS[5]).toEqual([
        152000, 612000, 1072000, 1378000, 2297500, 2872500, 3678000, 4368000, 5040000
      ]);
    });

    it('verifies Day 6 (PvP) exact thresholds (9 tiers)', () => {
      expect(GVG_CHEST_THRESHOLDS[6]).toEqual([
        120000, 250000, 752000, 1232000, 1572000, 2572000, 3172000, 4344000, 8500000
      ]);
    });

    it('verifies Day 0 (Aggregate Prep Total) matches sum of D1 + 3*D2 + D5', () => {
      expect(GVG_CHEST_THRESHOLDS[0]).toEqual([
        405000, 1625400, 2860000, 3572000, 6265000, 8420000, 11329000, 14659000, 18590000
      ]);
    });
  });

  describe('SvS Official Thresholds', () => {
    it('verifies Day 1 to 4 exact thresholds (9 tiers)', () => {
      const expected = [38000, 153000, 268000, 306000, 459000, 613000, 689000, 919000, 1150000];
      expect(SVS_CHEST_THRESHOLDS[1]).toEqual(expected);
      expect(SVS_CHEST_THRESHOLDS[2]).toEqual(expected);
      expect(SVS_CHEST_THRESHOLDS[3]).toEqual(expected);
      expect(SVS_CHEST_THRESHOLDS[4]).toEqual(expected);
    });

    it('verifies Day 5 exact thresholds (9 tiers)', () => {
      expect(SVS_CHEST_THRESHOLDS[5]).toEqual([
        76000, 306000, 536000, 689000, 919000, 1149000, 1226000, 1456000, 1680000
      ]);
    });

    it('verifies Day 6 (PvP) exact thresholds (9 tiers)', () => {
      expect(SVS_CHEST_THRESHOLDS[6]).toEqual([
        100000, 400000, 700000, 800000, 1200000, 1600000, 1800000, 2400000, 3020000
      ]);
    });

    it('verifies Day 0 (Aggregate Prep Total) matches sum of 4*D1 + D5', () => {
      expect(SVS_CHEST_THRESHOLDS[0]).toEqual([
        228000, 918000, 1608000, 1913000, 2755000, 3601000, 3982000, 5132000, 6280000
      ]);
    });
  });

  describe('defaultChestGrid event generation', () => {
    it('generates 63 tiers for GvG with 9 tiers per day and strictly ascending min_score', () => {
      const gvgGrid = defaultChestGrid('GvG');
      expect(gvgGrid.length).toBe(63);

      for (let d = 0; d <= 6; d++) {
        const slice = gvgGrid.filter((t) => t.day === d);
        expect(slice.length).toBe(9);
        for (let i = 0; i < 9; i++) {
          expect(slice[i].tier).toBe(i + 1);
          expect(slice[i].chests).toBe(i + 1);
          if (i > 0) {
            expect(slice[i].min_score).toBeGreaterThan(slice[i - 1].min_score);
          }
        }
      }
    });

    it('generates 63 tiers for SvS with 9 tiers per day and strictly ascending min_score', () => {
      const svsGrid = defaultChestGrid('SvS');
      expect(svsGrid.length).toBe(63);

      for (let d = 0; d <= 6; d++) {
        const slice = svsGrid.filter((t) => t.day === d);
        expect(slice.length).toBe(9);
        for (let i = 0; i < 9; i++) {
          expect(slice[i].tier).toBe(i + 1);
          expect(slice[i].chests).toBe(i + 1);
          if (i > 0) {
            expect(slice[i].min_score).toBeGreaterThan(slice[i - 1].min_score);
          }
        }
      }
    });
  });

  describe('Chest resolution calculations', () => {
    it('accurately resolves chests for GvG Day 6 PvP', () => {
      const gvgD6 = defaultChestGrid('GvG').filter((t) => t.day === 6);
      expect(resolveChestsForScore(gvgD6, 0)).toBe(0);
      expect(resolveChestsForScore(gvgD6, 119999)).toBe(0);
      expect(resolveChestsForScore(gvgD6, 120000)).toBe(1);
      expect(resolveChestsForScore(gvgD6, 249999)).toBe(1);
      expect(resolveChestsForScore(gvgD6, 250000)).toBe(2);
      expect(resolveChestsForScore(gvgD6, 752000)).toBe(3);
      expect(resolveChestsForScore(gvgD6, 1232000)).toBe(4);
      expect(resolveChestsForScore(gvgD6, 1572000)).toBe(5);
      expect(resolveChestsForScore(gvgD6, 2572000)).toBe(6);
      expect(resolveChestsForScore(gvgD6, 3172000)).toBe(7);
      expect(resolveChestsForScore(gvgD6, 4344000)).toBe(8);
      expect(resolveChestsForScore(gvgD6, 8500000)).toBe(9);
      expect(resolveChestsForScore(gvgD6, 50000000)).toBe(9);
    });

    it('accurately resolves chests for SvS Day 1', () => {
      const svsD1 = defaultChestGrid('SvS').filter((t) => t.day === 1);
      expect(resolveChestsForScore(svsD1, 0)).toBe(0);
      expect(resolveChestsForScore(svsD1, 38000)).toBe(1);
      expect(resolveChestsForScore(svsD1, 153000)).toBe(2);
      expect(resolveChestsForScore(svsD1, 268000)).toBe(3);
      expect(resolveChestsForScore(svsD1, 306000)).toBe(4);
      expect(resolveChestsForScore(svsD1, 459000)).toBe(5);
      expect(resolveChestsForScore(svsD1, 613000)).toBe(6);
      expect(resolveChestsForScore(svsD1, 689000)).toBe(7);
      expect(resolveChestsForScore(svsD1, 919000)).toBe(8);
      expect(resolveChestsForScore(svsD1, 1150000)).toBe(9);
    });
  });

  describe('Admin UI Accordion Structure', () => {
    it('ensures #chest-tiers-card is a details accordion closed by default', () => {
      expect(indexHtml).toContain('<details class="gm-card gm-card-padded gm-section chest-tiers-accordion" id="chest-tiers-card">');
      expect(indexHtml).not.toContain('<details class="gm-card gm-card-padded gm-section chest-tiers-accordion" id="chest-tiers-card" open>');
      expect(indexHtml).toContain('<summary class="chest-tiers-accordion-summary">');
      expect(indexHtml).toContain('chest-tiers-accordion-chevron');
      expect(indexHtml).toContain('id="chest-tiers-grid"');
      expect(indexHtml).toContain('id="chest-tiers-save"');
    });
  });

  describe('Database migration capacity guard', () => {
    it('ensures gm_save_chest_tiers check is widened to at least 120 tiers', () => {
      expect(migration).toContain('jsonb_array_length(p_tiers) > 120');
      expect(migration).toContain('CREATE OR REPLACE FUNCTION public.gm_save_chest_tiers');
      expect(migration).toContain('NOTIFY pgrst, \'reload schema\';');
    });
  });
});
