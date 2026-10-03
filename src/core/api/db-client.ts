/**
 * src/core/api/db-client.ts
 *
 * The client a data function receives (medium-term plan, M4b). Views and
 * controllers no longer build queries: they hold the client they always held
 * -- `window.GM.db`, the db-guard-wrapped Supabase client -- and hand it to a
 * module service, which builds the query and returns it for the caller to
 * await. Passing it in, rather than having each service look it up, keeps the
 * exact client (and so the tenant guard, and the fakes tests install) the
 * caller already checked for null.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The guarded Supabase client. Typed loosely, as every call site already treats it. */
export type DbClient = any;
