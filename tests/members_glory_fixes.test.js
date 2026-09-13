// Regression guards for the 2026-08-23 v128.1 fixes:
// 1. Members tab role-group accordions never collapsed (the .is-collapsed CSS
//    rule had never existed in any stylesheet despite the full JS wiring).
// 2. Glory OCR commits only updated guild_members.glory_score and never wrote
//    the weekly event_participants rows the Glory tab reads (week_start filter).

import { describe, it, expect } from 'vitest';
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
    const app = read('app.js');
    expect(app).toContain('.gm-role-group-header');
    expect(app).toContain('window.GM_COLLAPSED_ROLES[role] = !window.GM_COLLAPSED_ROLES[role]');
    expect(app).toMatch(/gm-role-group' \+ \(isCollapsed \? ' is-collapsed' : ''\)/);
  });
});

describe('Glory OCR weekly routing (v128.1)', () => {
  it('existing-member glory updates route through the gm_upsert_player_glory RPC', () => {
    const app = read('app.js');
    const commitIdx = app.indexOf('async function executeRosterCommit');
    const commitSrc = app.slice(commitIdx, commitIdx + 12000);
    expect(commitIdx).toBeGreaterThan(-1);
    // The glory branch calls the RPC (writes event_participants weekly row + syncs guild_members)
    expect(commitSrc).toContain("if (targetField === 'glory_score')");
    expect(commitSrc).toContain("db.rpc('gm_upsert_player_glory'");
    expect(commitSrc).toContain('p_week_start: gloryWeek');
    // Non-glory metrics keep the direct guild_members update
    expect(commitSrc).toContain("db.from('guild_members')");
  });

  it('new-member glory inserts also record the weekly event_participants row', () => {
    const app = read('app.js');
    const commitIdx = app.indexOf('async function executeRosterCommit');
    const commitSrc = app.slice(commitIdx, commitIdx + 16000);
    expect(commitSrc).toMatch(/if \(targetField === 'glory_score' && nScore > 0\)/);
    expect(commitSrc).toContain('p_week_start: gloryWeekNew');
  });

  it('the Glory tab still reads weekly scores from event_participants by week_start', () => {
    const glory = read('src/modules/glory/views/GloryView.ts');
    expect(glory).toContain(".eq('event_name', 'Glory')");
    expect(glory).toContain(".eq('week_start', week)");
  });
});
