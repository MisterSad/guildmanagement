/**
 * admin-accounts actions: approving or rejecting a pending player registration.
 */

import { decideRegistration } from "../../_shared/registration-decision.ts";
import { ApproveRejectSchema } from "../schemas.ts";
import type { AdminContext } from "../context.ts";

// Approve / reject a pending player registration. The whole decision --
// authorization, shadow-user provisioning, epoch bump, audit row, DM -- lives
// in _shared/registration-decision.ts, shared with the Discord buttons.
//
// `approve-registration` / `reject-registration`
export async function decideRegistrationAction(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, body, action } = ctx;
  const parsed = ApproveRejectSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "missing_fields" }, 400);
  const res = await decideRegistration(
    admin,
    logger,
    { role: info.role, guild: info.guild, serverNumber: info.serverNumber, accountId: info.accountId, via: "app" },
    parsed.data.id,
    action === "approve-registration" ? "approve" : "reject",
  );
  if (!res.ok) {
    return json({ ok: false, error: res.error, ...(res.message ? { message: res.message } : {}) }, res.status);
  }
  return json({ ok: true });
}
