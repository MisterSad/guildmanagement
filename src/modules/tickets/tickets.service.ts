/**
 * src/modules/tickets/tickets.service.ts
 *
 * Calls of the Tickets page to the `tickets` Edge Function (M4b). Each returns
 * the invoke promise; the view awaits it and keeps its own error handling.
 */

import type { DbClient } from '../../core/api/db-client';

/** Lists the tickets visible to the caller. */
export function listTickets(db: DbClient) {
  return db.functions.invoke('tickets', { body: { action: 'list' } });
}

/** Changes a ticket's status. */
export function updateTicketStatus(db: DbClient, id: any, status: string) {
  return db.functions.invoke('tickets', { body: { action: 'update-status', id: Number(id), status } });
}
