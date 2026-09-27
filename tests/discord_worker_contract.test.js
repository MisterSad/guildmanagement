// The always-on Discord worker is a live process holding the service-role key,
// and until 2026-09-28 nothing in CI looked at it beyond a handful of static
// greps. Three defects had survived there, all measured in production:
//
//   1. `/update-stats glory:` called `gm_submit_event_score`, a function that
//      exists in no migration and in no database. The worker inspected only the
//      transport error, so it answered "✅ Stats Updated" and wrote nothing.
//      (tests/rpc_names_exist.test.js now greps this directory too.)
//   2. `resolveLinkedAccount` used `.maybeSingle()` on `discord_account_links`,
//      which migration 20260927120000 re-keyed to (discord_user_id, account_id)
//      so one Discord identity can legitimately hold several accounts.
//      `.maybeSingle()` ERRORS on that rather than picking one, so every command
//      here already threw for the one identity in production that has two.
//   3. `/setup-server` selected `guilds.name`, a column production does not
//      have (42703), so `guildRow` was null for EVERY guild -- and the code then
//      invented server number "1000" and provisioned 31 channels for a tenant
//      that may not exist.
//
// These are source-level assertions because the worker is a Discord.js Gateway
// process: it cannot be imported and executed here. They pin the SHAPE of the
// fixes, which is what regressed.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getWeekStartIso } from '../supabase/functions/_shared/player-actions.ts';
import { getWeekStartIso as workerWeekStart } from '../discord-verification-worker/week.js';

const workerPath = path.resolve(__dirname, '../discord-verification-worker/index.js');
const provisionerPath = path.resolve(__dirname, '../discord-verification-worker/server-provisioner.js');
const workerSrc = fs.readFileSync(workerPath, 'utf-8');
const provisionerSrc = fs.readFileSync(provisionerPath, 'utf-8');

describe('the worker reads a Discord identity that may hold several accounts', () => {
  it('never calls maybeSingle() on discord_account_links', () => {
    const idx = workerSrc.indexOf('.from("discord_account_links")');
    expect(idx).toBeGreaterThan(-1);
    // The whole statement, up to the first semicolon at the start of a line.
    const stmt = workerSrc.slice(idx, idx + 400);
    expect(stmt).not.toContain('maybeSingle');
  });

  it('filters the linked accounts to active ones', () => {
    expect(workerSrc).toContain('.select("id, uid, guild, role, status")');
    expect(workerSrc).toMatch(/status === "active"/);
  });

  it('asks which account instead of silently picking one', () => {
    expect(workerSrc).toContain('function askWhichAccount');
    // Every interactive command that acts AS the player must offer the choice.
    const guards = workerSrc.match(/if \(await askWhichAccount\(interaction, linked\)\) return;/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it('treats an ambiguous link as resolving no guild in the best-effort paths', () => {
    // `linked.guild` is undefined for an ambiguous result, so a bare
    // `if (linked)` would set fgfGuild to undefined and read the wrong rows.
    expect(workerSrc).not.toMatch(/if \(linked\) fgfGuild = linked\.guild;/);
    expect(workerSrc).toMatch(/if \(linked && linked\.guild\) fgfGuild = linked\.guild;/);
    expect(workerSrc).toMatch(/if \(linked && linked\.guild\) \{/);
  });
});

describe('the worker never reports a write it did not get', () => {
  it('checks the ok flag returned by the metrics and glory RPCs, not just the transport error', () => {
    // Both RPCs answer with a row/object carrying `ok` and neither RAISEs, so a
    // null error proves nothing.
    expect(workerSrc).toContain('function rpcRowOk');
    expect(workerSrc).toMatch(/const powerRes = rpcRowOk\(powerData\)/);
    expect(workerSrc).toMatch(/const gloryRes = rpcRowOk\(gloryData\)/);
    expect(workerSrc).toMatch(/if \(rpcErr \|\| !powerRes\.ok\)/);
    expect(workerSrc).toMatch(/if \(rpcErr \|\| !gloryRes\.ok\)/);
  });

  it('calls the glory RPC that exists, and never the phantom one', () => {
    expect(workerSrc).toMatch(/\.rpc\("gm_upsert_player_glory"/);
    expect(workerSrc).not.toMatch(/\.rpc\("gm_submit_event_score"/);
  });

  it('files the Glory score under the same ISO Monday the app uses', () => {
    // The worker is plain Node and cannot import the Deno module, so the rule
    // exists twice. Both copies are imported here and compared, rather than
    // trusting a comment: if they drift, the bot and the app disagree about
    // which week a score belongs to -- and the Stats page groups by that week.
    expect(workerSrc).toContain('from "./week.js"');
    const cases = [
      '2026-09-28T00:00:00Z', // a Monday
      '2026-09-27T23:59:59Z', // the Sunday before it -- the off-by-one that matters
      '2026-10-01T12:00:00Z',
      '2026-01-01T00:00:00Z', // year boundary
      '2026-12-31T23:00:00Z', // ISO year boundary the other way
      '2026-03-29T01:30:00Z', // a European DST switch
    ];
    for (const iso of cases) {
      expect(workerWeekStart(new Date(iso)), iso).toBe(getWeekStartIso(new Date(iso)));
    }
    // And the shared rule really does land on Mondays.
    for (const iso of cases) {
      expect(new Date(`${workerWeekStart(new Date(iso))}T00:00:00Z`).getUTCDay(), iso).toBe(1);
    }
  });
});

describe('/setup-server refuses to build a server for a tenant that does not exist', () => {
  it('never selects guilds.name, a column production does not have', () => {
    expect(workerSrc).not.toMatch(/\.select\(["'][^"']*\bname\b[^"']*["']\)[\s\S]{0,80}\.eq\("id", rawGuild\)/);
    expect(workerSrc).toContain('.select("id, server_number")');
    expect(workerSrc).not.toContain('guildRow?.name');
  });

  it('refuses an unregistered guild instead of inventing one', () => {
    expect(workerSrc).toContain('if (!guildRow) {');
    expect(workerSrc).toMatch(/is not registered in the Guild Management tool/);
    const refusalIdx = workerSrc.indexOf('if (!guildRow) {');
    const setupIdx = workerSrc.indexOf('pendingSetups.set(');
    expect(refusalIdx).toBeGreaterThan(-1);
    expect(refusalIdx).toBeLessThan(setupIdx);
  });

  it('invents no server number, in the command or in the provisioner', () => {
    expect(workerSrc).not.toContain('|| "1000"');
    expect(provisionerSrc).not.toContain('|| "1000"');
    expect(workerSrc).toMatch(/has no game-server number on file/);
    expect(provisionerSrc).toContain('server_number_required');
  });
});

describe('the provisioner creates roles the verification flow can actually match', () => {
  // findRoleByNormalizedName compares normalizeTag(role.name), and normalizeTag
  // only strips brackets and upper-cases. "👽 Visitor" normalises to
  // "👽 VISITOR" and matched nothing, so every freshly provisioned server hit
  // the no_matching_role dead end.
  function normalizeTag(raw) {
    return (raw || '').replace(/[[\]]/g, '').trim().toUpperCase();
  }

  function roleNames() {
    const names = {};
    const re = /key: "(visitor|pending|member|officer|leader)",\s*\n\s*name: (`[^`]*`|"[^"]*")/g;
    let m;
    while ((m = re.exec(provisionerSrc)) !== null) {
      names[m[1]] = m[2].replace(/[`"]/g, '');
    }
    return names;
  }

  it('found the role template in the source', () => {
    const names = roleNames();
    expect(Object.keys(names).sort()).toEqual(['leader', 'member', 'officer', 'pending', 'visitor']);
  });

  it('names the visitor and pending roles exactly what the resolver looks for', () => {
    const names = roleNames();
    expect(normalizeTag(names.visitor)).toBe('VISITOR');
    expect(normalizeTag(names.pending)).toBe('PENDING');
  });

  it('names the member role after the guild tag alone, with nothing appended', () => {
    const names = roleNames();
    // The template interpolates ${cleanTag}; substitute a tag and check the
    // result is the tag and nothing else.
    expect(normalizeTag(names.member.replace('${cleanTag}', 'PR1M'))).toBe('PR1M');
  });

  it('no longer auto-wires a second tag-bearing role into guild_config', () => {
    // discord_member_role_id pointed at "[TAG] Member" and the worker granted it
    // on every successful verification, visitors included.
    expect(provisionerSrc).not.toMatch(/key: "discord_member_role_id"/);
  });
});

describe('one Gemini model list for the whole backend', () => {
  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.ts$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const files = walk(path.resolve(__dirname, '../supabase/functions'));

  it('mentions no Gemini model Google never published', () => {
    // gemini-3.5-flash / gemini-3.7-flash / gemini-3-flash-preview: the
    // Claude/GPT minor-version scheme pattern-matched onto the wrong vendor
    // (finding B1). Each one costs a full round trip and a 404.
    // Only a quoted occurrence is a model identifier the code would actually
    // send; _shared/gemini.ts names these in prose precisely to record that they
    // are not real, and that comment must stay readable.
    const offenders = files.filter((f) => /["']gemini-3/.test(fs.readFileSync(f, 'utf-8')));
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
    // Wired-to-real-data guard: the real list IS quoted, so a broken regex
    // cannot make this vacuous.
    const geminiSrc = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/_shared/gemini.ts'), 'utf-8');
    expect(/["']gemini-flash-latest["']/.test(geminiSrc)).toBe(true);
  });

  it('leaves gemini-vision.ts with no model list of its own', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/_shared/gemini-vision.ts'), 'utf-8');
    expect(src).toContain('from "./gemini.ts"');
    expect(src).toContain('GEMINI_MODEL_FALLBACKS');
    expect(src).not.toMatch(/MODELS_TO_TRY\s*=\s*\[/);
    // And it inherits the measured thinking-budget fix.
    expect(src).toContain('thinking_budget: 0');
    expect(src).toContain('geminiSupportsThinking');
  });
});
