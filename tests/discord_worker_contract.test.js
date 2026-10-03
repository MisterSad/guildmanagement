// The always-on Discord worker is a live process holding the service-role key,
// and until 2026-09-28 nothing in CI looked at it beyond a handful of static
// greps. Three defects had survived there, all measured in production:
//
//   1. `/update-stats glory:` called `gm_submit_event_score`, a function that
//      exists in no migration and in no database. The worker inspected only the
//      transport error, so it answered "✅ Stats Updated" and wrote nothing.
//      (tests/rpc_names_exist.test.js now greps this directory too.)
//   2. `resolveLinkedAccount` used `.maybeSingle()` on `discord_account_links`,
//      which migration 20260927001726 re-keyed to (discord_user_id, account_id)
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
    // /myinfo, /absent, /mystats. /update-stats is forwarded now, so its
    // ambiguity check lives in the Edge Function's own resolveLinkedAccount.
    expect(guards.length).toBeGreaterThanOrEqual(3);
    const botSrc2 = fs.readFileSync(
      path.resolve(__dirname, '../supabase/functions/discord-bot-interactions/index.ts'),
      'utf-8'
    );
    expect(botSrc2).toContain('linked to ${usable.length} player accounts'.replace('${usable.length}', '${usable.length}'));
  });

  it('treats an ambiguous link as resolving no guild in the best-effort paths', () => {
    // `linked.guild` is undefined for an ambiguous result, so a bare
    // `if (linked)` would set fgfGuild to undefined and read the wrong rows.
    expect(workerSrc).not.toMatch(/if \(linked\) fgfGuild = linked\.guild;/);
    expect(workerSrc).toMatch(/if \(linked && linked\.guild\) fgfGuild = linked\.guild;/);
    expect(workerSrc).toMatch(/if \(linked && linked\.guild\) \{/);
  });
});

describe('the worker does not write player stats at all any more', () => {
  it('forwards /update-stats instead of calling the RPCs directly', () => {
    // It used to call gm_upsert_player_metrics and gm_upsert_player_glory itself,
    // which meant no MAX_ALLOWED_POWER clamp and no audit row -- unlike
    // updatePlayerPower/updatePlayerGlory, which do both. Retiring /power and
    // /glory in favour of /update-stats would have LOST that, so /update-stats
    // moved to the Edge Function's audited helpers instead.
    expect(workerSrc).toContain('"update-stats"');
    expect(workerSrc).toContain('const FORWARDED_COMMANDS = new Set(["update-stats", "timezone", "challenges", "absence", "invite"])');
    expect(workerSrc).not.toMatch(/\.rpc\("gm_upsert_player_metrics"/);
    expect(workerSrc).not.toMatch(/\.rpc\("gm_upsert_player_glory"/);
    expect(workerSrc).not.toContain('function handleUpdateStats');
  });

  it('no longer carries a second copy of the ISO-Monday rule', () => {
    // week.js existed only so the worker could file a Glory score under the same
    // week as the app. The write went back to the Deno side, which has the
    // original, so the duplicate is deleted rather than left to drift.
    expect(fs.existsSync(path.resolve(__dirname, '../discord-verification-worker/week.js'))).toBe(false);
    expect(workerSrc).not.toContain('week.js');
    expect(workerSrc).not.toContain('function getWeekStartIso');
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

describe('one transport, one registry, one implementation', () => {
  // Measured 2026-09-28: discord-bot-interactions was invoked 0 times in 24
  // hours while discord-profile-verification was invoked 15, and the worker logs
  // registering nine commands over the Gateway. Discord delivers interactions
  // over ONE transport and for this application it is the Gateway -- so
  // /power, /glory, /timezone, /challenges and /absence, which exist on Discord,
  // had no handler at all and answered "The application did not respond".
  const botSrc = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/discord-bot-interactions/index.ts'),
    'utf-8'
  );

  it('routes the orphaned commands instead of reimplementing them', () => {
    expect(workerSrc).toContain('const FORWARDED_COMMANDS = new Set(["update-stats", "timezone", "challenges", "absence", "invite"])');
    expect(workerSrc).toContain('FORWARDED_COMMANDS.has(interaction.commandName)');
    expect(workerSrc).toContain('INTERACTIONS_FUNCTION_URL');
    // The validated write helpers stay on the Deno side, shared with the Portal.
    for (const helper of ['updatePlayerPower', 'updatePlayerGlory', 'updatePlayerTimezone', 'getPlayerChallenges']) {
      expect(botSrc, `${helper} must stay in the Edge Function`).toContain(helper);
      expect(workerSrc, `${helper} must NOT be reimplemented in the worker`).not.toContain(helper);
    }
  });

  it('acknowledges within Discord\'s 3-second window before the round trip', () => {
    const fwd = workerSrc.slice(workerSrc.indexOf('async function forwardInteraction'));
    const deferIdx = fwd.indexOf('deferReply');
    const fetchIdx = fwd.indexOf('fetch(INTERACTIONS_FUNCTION_URL');
    expect(deferIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(deferIdx);
  });

  it('sends Discord\'s raw option shape, not discord.js toJSON()', () => {
    // The Edge Function reads interaction.data.options and, for /absence, the
    // subcommand nested in options[0].options. discord.js toJSON() does not
    // return that.
    expect(workerSrc).toContain('function rawOptions');
    expect(workerSrc).toContain('function toRawInteraction');
    expect(workerSrc).not.toContain('interaction.toJSON');
    expect(botSrc).toContain('interaction.data?.options?.[0]');
  });

  it('accepts the worker secret AND the Ed25519 signature, and refuses a wrong secret outright', () => {
    expect(botSrc).toContain('DISCORD_WORKER_SECRET');
    expect(botSrc).toContain('safeEqual(authBearer, DISCORD_WORKER_SECRET)');
    expect(botSrc).toContain('verifyDiscordSignature');
    // A present-but-wrong bearer must not fall through to the signature branch.
    const elseIdx = botSrc.indexOf('} else {', botSrc.indexOf('if (fromWorker)'));
    const sigIdx = botSrc.indexOf('verifyDiscordSignature(publicKey');
    const refuseIdx = botSrc.indexOf('Rejected interaction with an invalid worker secret');
    expect(refuseIdx).toBeGreaterThan(elseIdx);
    expect(refuseIdx).toBeLessThan(sigIdx);
  });

  it('has exactly one command registry in the repository', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../scripts/register-discord-commands.mjs'))).toBe(false);
    // Every command the worker forwards must also be one the worker defines,
    // or Discord would serve a command no source file describes.
    for (const name of ['update-stats', 'timezone', 'challenges', 'absence']) {
      expect(workerSrc, `/${name} must be defined in the worker`).toMatch(
        new RegExp(`name: "${name}"`)
      );
      expect(workerSrc, `/${name} must be registered`).toContain(`["${name}", `);
    }
    // And a retired command must be actively excluded, not merely dropped.
    expect(workerSrc).toContain('const RETIRED_COMMANDS = new Set(["power", "glory", "link"])');
    const desiredBlock = workerSrc.slice(workerSrc.indexOf('const desired = new Map(['), workerSrc.indexOf('const body = []'));
    expect(desiredBlock.length).toBeGreaterThan(100);
    for (const retired of ['power', 'glory', 'link']) {
      expect(desiredBlock, `/${retired} must not be registered`).not.toContain(`["${retired}", `);
    }
  });

  it('registers commands in ONE scope, and clears the other', () => {
    // Discord lists global and guild-scoped commands separately, so a command in
    // both appears TWICE in the picker. Registering per guild for instant
    // availability used to fail on every boot (the global ids a guild-scoped PUT
    // rejects); making it succeed made every command show up twice. The guild
    // scope is cleared instead.
    expect(workerSrc).toContain('Routes.applicationCommands(appId), { body }');
    expect(workerSrc).toContain('body: [] }');
    expect(workerSrc).not.toContain('const guildBody =');
    // And nothing may register into guild scope any more, on boot or on join.
    const guildPuts = workerSrc.match(/rest\.put\(Routes\.applicationGuildCommands\([^)]*\), \{ body: (?!\[\] )/g) || [];
    expect(guildPuts).toEqual([]);
  });

  it('does not re-create the duplication when the bot joins a server', () => {
    const gc = workerSrc.slice(workerSrc.indexOf('client.on("guildCreate"'), workerSrc.indexOf('client.on("messageCreate"'));
    expect(gc).not.toContain('applicationGuildCommands');
    expect(gc).toContain('global commands already apply');
  });
});

describe('/mystats reports the app\'s numbers without inventing a new one', () => {
  it('uses gm_player_stats, the only stats RPC a service-role caller can reach', () => {
    expect(workerSrc).toContain('.rpc("gm_player_stats"');
    // The gated ones return false when auth.uid() is NULL, so the worker must
    // never CALL them. They are named in a comment on purpose, to say why.
    for (const gated of ['gm_stats_weeks', 'gm_stats_members', 'gm_stats_health', 'gm_stats_events']) {
      expect(workerSrc, `${gated} is unreachable from the worker`).not.toContain(`.rpc("${gated}"`);
    }
  });

  it('computes no weighted score of its own', () => {
    // The weighting lives in src/core/scoring/reliability.ts, shared by the admin
    // page and the Portal. A third copy here is how those two came to disagree.
    const fn = workerSrc.slice(workerSrc.indexOf('async function handleMyStats'), workerSrc.indexOf('async function handleVerifications'));
    expect(fn).not.toMatch(/coeff|weight|reliability_score/i);
    // It reports att/opp and the guild's pooled rate, nothing more.
    expect(fn).toContain('mine.att');
    expect(fn).toContain('theirs.member_opportunities');
  });

  it('bounds the week window on the client side too', () => {
    expect(workerSrc).toContain('Math.min(Math.max(requested ?? 4, 1), 26)');
  });

  it('is ephemeral, so a player cannot read it off someone else\'s screen', () => {
    const fn = workerSrc.slice(workerSrc.indexOf('async function handleMyStats'), workerSrc.indexOf('async function handleVerifications'));
    expect(fn).toContain('ephemeral: true');
  });
});

describe('/verifications never takes the guild from the caller', () => {
  const fn = () => workerSrc.slice(
    workerSrc.indexOf('async function handleVerifications'),
    workerSrc.indexOf('function normalizeTag')
  );

  it('resolves the guild from the channel map or the linked account only', () => {
    const body = fn();
    expect(body).toContain('channelToGuild.get(interaction.channelId)');
    expect(body).toContain('resolveLinkedAccount(interaction.user.id)');
    // No guild option exists to be supplied.
    expect(body).not.toMatch(/getString\(\s*["']guild["']/);
    expect(workerSrc.slice(workerSrc.indexOf('const VERIFICATIONS_COMMAND'), workerSrc.indexOf('const LINK_COMMAND'))).not.toMatch(/name: "guild"/);
  });

  it('is gated by a Discord permission, not by an app role', () => {
    const defIdx = workerSrc.indexOf('const VERIFICATIONS_COMMAND');
    expect(defIdx).toBeGreaterThan(-1);
    const def = workerSrc.slice(defIdx, workerSrc.indexOf('};', defIdx));
    expect(def).toContain('default_member_permissions: String(PermissionFlagsBits.ManageMessages)');
    // And the officer command for role removal is gated too.
    const recIdx = workerSrc.indexOf('const RECONCILE_ROLES_COMMAND');
    const rec = workerSrc.slice(recIdx, workerSrc.indexOf('};', recIdx));
    expect(rec).toContain('default_member_permissions: String(PermissionFlagsBits.ManageRoles)');
  });

  it('reads the audit rows ADR-020 writes, bounded and ephemeral, pinging nobody', () => {
    const body = fn();
    expect(body).toContain('"discord_verification_refused"');
    expect(body).toContain('.limit(20)');
    expect(body).toContain('ephemeral: true');
    expect(body).toContain('allowedMentions: { parse: [] }');
  });
});

describe('/reconcile-roles reports before it removes', () => {
  const fn = () => workerSrc.slice(
    workerSrc.indexOf('async function handleReconcileRoles'),
    workerSrc.indexOf('async function handleReconcileButton')
  );

  it('does not request the privileged members intent unless it was switched on', () => {
    // Declaring GuildMembers while the Developer Portal toggle is off makes the
    // bot fail to log in entirely -- the whole bot, for one command.
    expect(workerSrc).toContain("const MEMBERS_INTENT_ENABLED = (process.env.DISCORD_GUILD_MEMBERS_INTENT || \"\").trim() === \"true\"");
    expect(workerSrc).toContain('...(MEMBERS_INTENT_ENABLED ? [GatewayIntentBits.GuildMembers] : [])');
    expect(fn()).toContain('if (!MEMBERS_INTENT_ENABLED)');
    expect(fn()).toContain('Server Members Intent');
  });

  it('says at startup whether the intent is in effect', () => {
    // A successful login is IDENTICAL whether the intent was declared and
    // accepted or never requested, so the log has to state which -- otherwise
    // the only way to know is to run the command and read its refusal.
    const ready = workerSrc.slice(workerSrc.indexOf('logged in as'));
    expect(ready).toContain('MEMBERS_INTENT_ENABLED');
    expect(ready).toContain('GuildMembers intent:');
  });

  it('removes nothing without a confirmation button from the officer who asked', () => {
    const body = fn();
    expect(body).toContain('pendingReconciles.set');
    expect(body).toContain('reconcile_confirm_');
    expect(body).not.toContain('roles.remove');

    const btn = workerSrc.slice(workerSrc.indexOf('async function handleReconcileButton'));
    expect(btn).toContain('interaction.user.id !== pending.initiatorId');
    const guardIdx = btn.indexOf('interaction.user.id !== pending.initiatorId');
    const removeIdx = btn.indexOf('roles.remove');
    expect(removeIdx).toBeGreaterThan(guardIdx);
  });

  it('only ever takes off the tag role, and never kicks', () => {
    const btn = workerSrc.slice(workerSrc.indexOf('async function handleReconcileButton'));
    expect(btn).toContain('member.roles.remove(pending.roleId');
    expect(btn).not.toMatch(/\.kick\(|\.ban\(/);
    expect(workerSrc).not.toMatch(/\.kick\(|\.ban\(/);
  });

  it('never touches a member it could not identify', () => {
    const body = fn();
    expect(body).toContain('unidentified.push');
    // The orphan list is what the button acts on; unidentified holders are only
    // ever reported.
    expect(body).toContain('memberIds: orphans.map');
    expect(body).not.toContain('memberIds: unidentified');
  });

  it('refuses to report anyone as missing on a truncated roster read', () => {
    expect(fn()).toContain('rosterRows.length >= 5000');
  });
});
