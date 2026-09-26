/**
 * src/core/api/db-guard.ts
 *
 * Multi-tenant write guard (port of the gm-utils.js db.from interception).
 * For the tenant tables it:
 *   a) blocks delete/update/insert/upsert when the caller cannot write the
 *      active guild, returning a "Read-only access" error;
 *   b) injects `guild: <activeGuild>` on insert/upsert;
 *   c) appends `.eq('guild', activeGuild)` on delete/update;
 *   d) invalidates the Stats/History freshness markers for that guild.
 *
 * (d) is here rather than at each mutation site because there are 55 write call
 * sites across the event views and none of them invalidated anything: editing a
 * war score and switching to Stats within the 15s TTL showed the pre-edit
 * numbers. The guard is the one place every tenant write must pass through, so
 * the invalidation cannot be forgotten or drift.
 *
 * Invalidation happens when the write is *issued*, not when it resolves. That
 * is deliberate: it avoids wrapping the returned builder (whose chain is
 * delicate -- `.eq()` is appended after `.delete()`), and the failure mode is
 * harmless. A write that later fails has merely dropped a freshness marker, so
 * the next visit refetches identical data.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { canWriteGuild, getActiveGuild } from '../auth/roles';
import { invalidateGuildViews } from '../cache/cache';

export const TENANT_TABLES = [
  'guild_members',
  'banned_players',
  'event_status',
  'event_participants',
  'event_daily_scores',
  'event_chest_tiers',
  'war_opponents',
  'war_sessions',
  'sanctions',
  'weekly_scores',
  'guild_config',
  'shadowfront_signups',
  'shadowfront_squads',
  'player_name_history'
];

export const READ_ONLY_MESSAGE = "Read-only access: you do not have permission to modify this guild's data.";

function readOnlyResult(): any {
  return {
    then: (resolve: (value: any) => unknown) =>
      Promise.resolve({ data: null, error: { message: READ_ONLY_MESSAGE } }).then(resolve)
  };
}

/** Wraps a Supabase client so tenant writes are guarded. Idempotent. */
export function installDbWriteGuard(db: any): any {
  if (!db || typeof db.from !== 'function') return db;
  if (db.__gmGuardInstalled) return db;

  const originalFrom = db.from.bind(db);

  db.from = function (table: string): any {
    const builder = originalFrom(table);
    if (TENANT_TABLES.indexOf(table) === -1) return builder;

    const originalDelete = builder.delete;
    builder.delete = function (...args: any[]): any {
      const currentG = getActiveGuild();
      if (!canWriteGuild(currentG)) return readOnlyResult();
      invalidateGuildViews(currentG);
      return originalDelete.apply(this, args).eq('guild', currentG);
    };

    const originalUpdate = builder.update;
    builder.update = function (values: any, options?: any): any {
      const currentG = getActiveGuild();
      if (!canWriteGuild(currentG)) return readOnlyResult();
      invalidateGuildViews(currentG);
      return originalUpdate.call(this, values, options).eq('guild', currentG);
    };

    const originalInsert = builder.insert;
    builder.insert = function (values: any, options?: any): any {
      const currentG = getActiveGuild();
      if (!canWriteGuild(currentG)) return readOnlyResult();
      invalidateGuildViews(currentG);
      let v = values;
      if (Array.isArray(v)) {
        v = v.map((x) => Object.assign({}, x, { guild: x && x.guild ? x.guild : currentG }));
      } else if (v && typeof v === 'object') {
        v = Object.assign({}, v, { guild: v.guild ? v.guild : currentG });
      }
      return originalInsert.call(this, v, options);
    };

    const originalUpsert = builder.upsert;
    builder.upsert = function (values: any, options?: any): any {
      const currentG = getActiveGuild();
      if (!canWriteGuild(currentG)) return readOnlyResult();
      invalidateGuildViews(currentG);
      let v = values;
      if (Array.isArray(v)) {
        v = v.map((x) => Object.assign({}, x, { guild: x && x.guild ? x.guild : currentG }));
      } else if (v && typeof v === 'object') {
        v = Object.assign({}, v, { guild: v.guild ? v.guild : currentG });
      }
      return originalUpsert.call(this, v, options);
    };

    return builder;
  };

  db.__gmGuardInstalled = true;
  return db;
}
