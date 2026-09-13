/**
 * src/core/api/db-guard.ts
 *
 * Multi-tenant write guard (port of the gm-utils.js db.from interception).
 * For the tenant tables it:
 *   a) blocks delete/update/insert/upsert when the caller cannot write the
 *      active guild, returning a "Read-only access" error;
 *   b) injects `guild: <activeGuild>` on insert/upsert;
 *   c) appends `.eq('guild', activeGuild)` on delete/update.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { canWriteGuild, getActiveGuild } from '../auth/roles';

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
  'push_subscriptions',
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
      return originalDelete.apply(this, args).eq('guild', currentG);
    };

    const originalUpdate = builder.update;
    builder.update = function (values: any, options?: any): any {
      const currentG = getActiveGuild();
      if (!canWriteGuild(currentG)) return readOnlyResult();
      return originalUpdate.call(this, values, options).eq('guild', currentG);
    };

    const originalInsert = builder.insert;
    builder.insert = function (values: any, options?: any): any {
      const currentG = getActiveGuild();
      if (!canWriteGuild(currentG)) return readOnlyResult();
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
