/**
 * src/modules/shell/shell.service.ts
 *
 * Calls the shell makes to the backend (M4b). Each returns the promise; the
 * view awaits it and keeps its own error handling.
 */

import type { DbClient } from '../../core/api/db-client';

/** The fields of a ticket filed from the shell's "report a problem" form. */
export interface NewTicketFields {
  title: string;
  description: string;
  category: any;
  severity: any;
  currentBehavior: string;
  expectedBehavior: string;
  steps: any;
  additionalContext: any;
  env: any;
  attachedScreenshots: any;
}

/** Files a ticket through the `tickets` Edge Function. */
export function createTicket(db: DbClient, f: NewTicketFields) {
  const {
    title,
    description,
    category,
    severity,
    currentBehavior,
    expectedBehavior,
    steps,
    additionalContext,
    env,
    attachedScreenshots,
  } = f;
  return db.functions.invoke('tickets', {
    body: {
      action: 'create',
      title,
      description,
      category,
      severity,
      current_behavior: currentBehavior,
      expected_behavior: expectedBehavior,
      steps,
      additional_context: additionalContext,
      env,
      attachments: attachedScreenshots,
    },
  });
}
