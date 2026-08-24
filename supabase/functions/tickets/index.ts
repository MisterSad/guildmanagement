import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { validateCallerAuth } from "../_shared/auth.ts";
import { getCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// Central bug-report Discord webhook URL (set via `supabase secrets set
// TICKET_WEBHOOK_URL=...`). This is a send-token secret: never committed,
// never echoed. Only the edge reads it.
const TICKET_WEBHOOK_URL = Deno.env.get("TICKET_WEBHOOK_URL") ?? "";

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

const ADMIN_ROLES = ["super_admin", "server_admin", "guild_admin"];

// SSRF-safe check mirroring discord-webhook-proxy: only real Discord webhook
// URLs are accepted, and redirects are never followed.
function isValidDiscordWebhook(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const clean = url.trim();
    const u = new URL(clean.startsWith("http") ? clean : "https://" + clean);
    return (
      u.protocol === "https:" &&
      (u.hostname === "discord.com" ||
        u.hostname === "discordapp.com" ||
        u.hostname.endsWith(".discord.com") ||
        u.hostname.endsWith(".discordapp.com")) &&
      u.pathname.includes("/webhooks/")
    );
  } catch {
    return false;
  }
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mimeType: string; extension: string } | null {
  if (typeof dataUrl !== "string") return null;
  try {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    const mimeType = match[1];
    const b64 = match[2];
    const binaryStr = atob(b64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    let extension = "jpg";
    if (mimeType.includes("png")) extension = "png";
    else if (mimeType.includes("webp")) extension = "webp";
    return { bytes, mimeType, extension };
  } catch {
    return null;
  }
}

const SEVERITY_META: Record<string, { label: string; color: number }> = {
  low:     { label: "Low",     color: 5763719 }, // slate/grey
  medium:  { label: "Medium",  color: 15105570 }, // amber
  high:    { label: "High",    color: 16753920 }, // orange
  critical:{ label: "Critical",color: 15158332 }, // red
};

const STATUS_META: Record<string, { label: string; color: number }> = {
  waiting:     { label: "⏳ Waiting for resolution", color: 15105570 }, // amber
  in_progress: { label: "🔨 In progress (Working on it)", color: 3447003 }, // blue
  open:        { label: "⏳ Waiting for resolution", color: 15105570 },
  resolved:    { label: "✅ Resolved", color: 3066993 }, // green
  closed:      { label: "🔒 Closed", color: 9807270 }, // slate grey
};

const CATEGORY_LABEL: Record<string, string> = {
  bug: "Bug",
  feature: "Feature request",
  other: "Other",
};

serve(async (req: Request) => {
  const json = makeJson(req);
  const logger = new EdgeLogger("tickets", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const caller = await validateCallerAuth(req, SUPABASE_URL, ANON_KEY, SERVICE_ROLE);
  if (!caller.authenticated || !caller.role || !ADMIN_ROLES.includes(caller.role)) {
    logger.warn("Forbidden tickets call", { role: caller.role, authenticated: caller.authenticated });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const action = (body?.action ?? "").toString();

  if (action === "create") {
    const title = (body?.title ?? "").toString().trim();
    const description = (body?.description ?? "").toString().trim();
    const category = (body?.category ?? "bug").toString();
    const severity = (body?.severity ?? "medium").toString();
    const guild = caller.role === "super_admin" && body?.guild
      ? (body.guild as string).toString().trim()
      : (caller.guild ?? "").trim();

    if (!title || !description) {
      return json({ ok: false, error: "missing_fields" }, 400);
    }

    const rawAttachments = Array.isArray(body?.attachments) ? body.attachments : [];
    const attachments = rawAttachments
      .filter((a) => typeof a === "string" && a.startsWith("data:image/") && a.length < 2_500_000)
      .slice(0, 3);

    const { data, error } = await admin.rpc("gm_create_ticket", {
      p_title: title,
      p_description: description,
      p_category: category,
      p_severity: severity,
      p_guild: guild,
      p_reporter_account_id: caller.accountId,
      p_reporter_role: caller.role,
      p_attachments: attachments,
    });

    if (error) {
      logger.error("gm_create_ticket failed", error, { role: caller.role });
      return json({ ok: false, error: "server_error" }, 500);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.ticket_number || !["open", "waiting"].includes(row.status)) {
      return json({ ok: false, error: row?.status || "create_failed" }, 200);
    }

    // Dispatch the Discord embed via the existing webhook proxy (SSRF-safe).
    const ticketNo = Number(row.ticket_number);
    const sev = SEVERITY_META[severity] || SEVERITY_META.medium;

    const currentBehavior = (body?.current_behavior ?? "").toString().trim();
    const expectedBehavior = (body?.expected_behavior ?? "").toString().trim();
    const steps = (body?.steps ?? "").toString().trim();
    const additionalContext = (body?.additional_context ?? "").toString().trim();
    const envObj = (body?.env && typeof body.env === "object") ? (body.env as Record<string, string>) : null;

    const embedFields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: "Status", value: "⏳ Waiting for resolution", inline: true },
      { name: "Category", value: CATEGORY_LABEL[category] || category, inline: true },
      { name: "Severity", value: sev.label, inline: true },
      { name: "Reporter", value: `${caller.accountId || "unknown"} (${caller.role})`, inline: true },
      { name: "Guild", value: guild || "Global", inline: true },
    ];

    if (envObj) {
      const envText = `• FGF: ${envObj.appVersion || "Unknown"}\n• OS: ${envObj.os || "Unknown"}\n• Browser: ${envObj.browser || "Unknown"}`;
      embedFields.push({ name: "Environment", value: envText, inline: true });
    }

    if (currentBehavior) {
      embedFields.push({ name: "Current Behavior / Issue", value: currentBehavior.length > 1020 ? currentBehavior.slice(0, 1017) + "…" : currentBehavior, inline: false });
    }
    if (expectedBehavior) {
      embedFields.push({ name: "Expected Behavior", value: expectedBehavior.length > 1020 ? expectedBehavior.slice(0, 1017) + "…" : expectedBehavior, inline: false });
    }
    if (steps) {
      embedFields.push({ name: "Steps to Reproduce", value: steps.length > 1020 ? steps.slice(0, 1017) + "…" : steps, inline: false });
    }
    if (additionalContext) {
      embedFields.push({ name: "Additional Context", value: additionalContext.length > 1020 ? additionalContext.slice(0, 1017) + "…" : additionalContext, inline: false });
    }
    if (!currentBehavior && !expectedBehavior) {
      embedFields.push({ name: "Description", value: description.length > 1020 ? description.slice(0, 1017) + "…" : description, inline: false });
    }

    const embed: Record<string, unknown> = {
      title: `#TICKET-${String(ticketNo).padStart(4, "0")} — ${title}`,
      color: sev.color,
      fields: embedFields,
      timestamp: new Date().toISOString(),
      footer: { text: "FGF Guild Management Tool — Bug Report" },
    };

    let webhookOk = false;
    const TICKET_STATUS_WEBHOOK_URL = Deno.env.get("TICKET_STATUS_WEBHOOK_URL") || TICKET_WEBHOOK_URL;
    if (TICKET_STATUS_WEBHOOK_URL && isValidDiscordWebhook(TICKET_STATUS_WEBHOOK_URL)) {
      try {
        let discordRes: Response;
        if (attachments.length > 0) {
          const form = new FormData();
          const p0 = dataUrlToBytes(attachments[0]);
          if (p0) {
            embed.image = { url: `attachment://screenshot_0.${p0.extension}` };
            form.append("files[0]", new Blob([p0.bytes], { type: p0.mimeType }), `screenshot_0.${p0.extension}`);
          }
          for (let i = 1; i < attachments.length; i++) {
            const pi = dataUrlToBytes(attachments[i]);
            if (pi) {
              form.append(`files[${i}]`, new Blob([pi.bytes], { type: pi.mimeType }), `screenshot_${i}.${pi.extension}`);
            }
          }
          form.append("payload_json", JSON.stringify({ embeds: [embed] }));
          discordRes = await fetch(TICKET_STATUS_WEBHOOK_URL, {
            method: "POST",
            body: form,
            redirect: "error",
          });
        } else {
          discordRes = await fetch(TICKET_STATUS_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ embeds: [embed] }),
            redirect: "error",
          });
        }
        webhookOk = discordRes.ok || discordRes.status === 204;
        if (!webhookOk) {
          logger.warn("Ticket Discord dispatch failed", { ticketNo, status: discordRes.status });
        }
      } catch (e) {
        logger.warn("Ticket Discord dispatch error", undefined, { ticketNo, message: String((e as Error)?.message || e) });
      }
    } else {
      logger.warn("TICKET_WEBHOOK_URL missing or invalid", { ticketNo });
    }

    // Audit log (service role can write to system_audit_logs).
    try {
      await admin.rpc("gm_log_player_audit", {
        p_action_type: "ticket_created",
        p_pseudo: caller.accountId,
        p_uid: caller.userId,
        p_guild: guild,
        p_message: `Bug report #TICKET-${String(ticketNo).padStart(4, "0")}: ${title}`,
        p_metadata: { ticket_number: ticketNo, category, severity, webhook: webhookOk },
        p_service: "tickets",
      });
    } catch (auditErr) {
      logger.warn("Ticket audit log failed", undefined, { ticketNo });
    }

    return json({
      ok: true,
      ticket_number: ticketNo,
      ticket_id: row.id,
      webhook: webhookOk,
    });
  }

  if (action === "list") {
    if (caller.role !== "super_admin") {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    const { data, error } = await admin.rpc("gm_list_tickets");
    if (error) {
      logger.error("gm_list_tickets failed", error);
      return json({ ok: false, error: "server_error" }, 500);
    }
    return json({ ok: true, tickets: data || [] });
  }

  if (action === "update-status") {
    if (caller.role !== "super_admin") {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    const id = Number(body?.id);
    const status = (body?.status ?? "").toString();
    if (!id || !["waiting", "in_progress", "resolved", "closed", "open"].includes(status)) {
      return json({ ok: false, error: "invalid_input" }, 400);
    }
    const { data, error } = await admin.rpc("gm_update_ticket_status", { p_id: id, p_status: status });
    if (error) {
      logger.error("gm_update_ticket_status failed", error);
      return json({ ok: false, error: "server_error" }, 500);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.ok) return json({ ok: false, error: row?.error || "update_failed" }, 200);

    const ticketNo = Number(row.ticket_number || id);
    const oldStatusKey = (row.old_status || "waiting").toString();
    const newStatusKey = (row.new_status || status).toString();
    const oldMeta = STATUS_META[oldStatusKey] || { label: oldStatusKey, color: 9807270 };
    const newMeta = STATUS_META[newStatusKey] || { label: newStatusKey, color: 9807270 };

    let webhookOk = false;
    const TICKET_STATUS_WEBHOOK_URL = Deno.env.get("TICKET_STATUS_WEBHOOK_URL") || TICKET_WEBHOOK_URL;
    if (TICKET_STATUS_WEBHOOK_URL && isValidDiscordWebhook(TICKET_STATUS_WEBHOOK_URL)) {
      try {
        const embed = {
          title: `Ticket Status: #TICKET-${String(ticketNo).padStart(4, "0")}`,
          description: `**${row.title || "Bug Report"}**\nStatus has been updated to **${newMeta.label}**.`,
          color: newMeta.color,
          fields: [
            { name: "New Status", value: newMeta.label, inline: true },
            { name: "Previous Status", value: oldMeta.label, inline: true },
            { name: "Updated By", value: `${caller.accountId || "Super Admin"} (${caller.role})`, inline: true },
            { name: "Guild", value: row.guild || "Global", inline: true },
            { name: "Category", value: CATEGORY_LABEL[row.category] || row.category || "Bug", inline: true },
            { name: "Severity", value: (SEVERITY_META[row.severity]?.label) || row.severity || "Medium", inline: true },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: "FGF Guild Management Tool — Ticket Status Update" },
        };

        const discordRes = await fetch(TICKET_STATUS_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
          redirect: "error",
        });
        webhookOk = discordRes.ok || discordRes.status === 204;
      } catch (e) {
        logger.warn("Ticket status Discord dispatch error", undefined, { ticketNo, message: String((e as Error)?.message || e) });
      }
    }

    try {
      await admin.rpc("gm_log_player_audit", {
        p_action_type: "ticket_status_updated",
        p_pseudo: caller.accountId,
        p_uid: caller.userId,
        p_guild: row.guild,
        p_message: `Ticket #TICKET-${String(ticketNo).padStart(4, "0")} status changed from ${oldStatusKey} to ${newStatusKey}`,
        p_metadata: { ticket_number: ticketNo, old_status: oldStatusKey, new_status: newStatusKey, webhook: webhookOk },
        p_service: "tickets",
      });
    } catch {
      // ignore
    }

    return json({ ok: true, webhook: webhookOk });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
