/**
 * supabase/functions/admin-accounts/context.ts
 *
 * What every admin-accounts action receives: an administrator already
 * authenticated, rate-limited and resolved by _shared/auth.ts.
 */

import type { EdgeLogger } from "../_shared/logger.ts";
import type { AdminClient } from "../_shared/db.ts";
import type { CallerInfo } from "../_shared/auth.ts";

export interface AdminContext {
  admin: AdminClient;
  logger: EdgeLogger;
  json: (body: unknown, status?: number) => Response;
  /** The caller: role is one of the three administrative roles. */
  info: CallerInfo;
  callerGuild: string | null;
  /** The raw request body; each action validates it with its own schema. */
  body: Record<string, unknown>;
  action: string;
}
