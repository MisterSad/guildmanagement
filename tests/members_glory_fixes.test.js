// Regression guards for the 2026-08-23 v128.1 fixes:
// 1. Members tab role-group accordions never collapsed (the .is-collapsed CSS
//    rule had never existed in any stylesheet despite the full JS wiring).
// 2. Glory OCR commits only updated guild_members.glory_score and never wrote
//    the weekly event_participants rows the Glory tab reads (week_start filter).

import { describe, it, expect } from 'vitest';
import { squash } from './helpers/source-text.js';
import { sqlFunctionBody } from './helpers/sql-function.js';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Members accordion collapse (v128.1)', () => {
  it('defines CSS rules that visually collapse a role group flagged is-collapsed', () => {
    const css = read('components.css');
    expect(css).toMatch(/\.gm-role-group\.is-collapsed \.gm-role-group-body\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.gm-role-group\.is-collapsed \.gm-role-group-caret\s*\{\s*transform:\s*rotate\(-90deg\)/);
  });

  it('the accordion JS wiring is intact (header click toggles collapse state)', () => {
    const app = read('src/modules/app/members/members.render.ts');
    expect(app).toContain('.gm-role-group-header');
    // Phase 7: the toggle goes through the typed store instead of poking the
    // `window` mirror, which used to leave getAppState() stale.
    expect(app).toContain('patchAppState({ collapsedRoles:');
    expect(app).toContain('!current[key]');
    expect(squash(app)).toMatch(/gm-role-group' \+ \(collapsed \? ' is-collapsed' : ''\)/);
  });
});

describe('Glory OCR weekly routing (v128.1)', () => {
  // M4a: the roster import is gm_commit_ocr_roster, all-or-nothing.
  it('existing-member glory updates route through the gm_upsert_player_glory RPC', () => {
    const fn = sqlFunctionBody('gm_commit_ocr_roster');
    expect(fn).toContain("IF p_field = 'glory_score' THEN");
    expect(fn).toContain('public.gm_upsert_player_glory(v_guild, v_pseudo, v_week, v_score)');
    // Non-glory metrics keep the direct guild_members update
    expect(fn).toContain("'UPDATE public.guild_members SET %I = $1");
    expect(read('src/modules/app/ocr/ocr.controller.ts')).toContain(
      'await commitOcrRoster(targetField, existingRows, newRows, checkedRemovalPseudos)'
    );
  });

  it('new-member glory inserts also record the weekly event_participants row', () => {
    expect(sqlFunctionBody('gm_commit_ocr_roster')).toContain("IF p_field = 'glory_score' AND v_score > 0 THEN");
  });

  it('the Glory tab still reads weekly scores from event_participants by week_start', () => {
    // The query lives in the module service since M4b; the view calls it per week.
    const service = read('src/modules/glory/glory.service.ts');
    expect(service).toContain(".eq('event_name', 'Glory')");
    expect(service).toContain(".eq('week_start', week)");
    const glory = read('src/modules/glory/views/GloryView.ts');
    expect(glory).toContain('fetchGloryWeekScores(db, currentG, week)');
  });
});
