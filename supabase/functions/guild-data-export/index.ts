/**
 * supabase/functions/guild-data-export/index.ts
 *
 * Lets a guild_admin (or server_admin/super_admin) download every piece of
 * their guild's data as a single, well-formatted .xlsx workbook -- one
 * sheet per data category, each a real Excel Table (header row, filter
 * dropdowns, banded rows), not just raw values.
 *
 * First Edge Function in this project to return a binary file instead of
 * JSON (Content-Disposition attachment), and the first to use ExcelJS --
 * both validated live against this exact Deno Edge Runtime before this
 * file was written (a throwaway test function generated a real, openable
 * .xlsx with a styled table and was deleted once confirmed).
 *
 * Auth follows the exact same guild-scoping pattern already established in
 * admin-accounts' "set-join-code"/"get-join-code" actions: guild_admin is
 * forced onto their own guild (never a client-supplied one), server_admin
 * must match the target guild's server_number, super_admin always passes.
 */
import ExcelJS from "npm:exceljs@4.4.0";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { resolveCaller } from "../_shared/auth.ts";
import { escapeOrFilterValue } from "../_shared/like.ts";
import { isAdminRole, isGuildAdmin, isGuildInScope } from "../_shared/admin-authz.ts";
import { fetchAllRows } from "../_shared/pagination.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { serviceClient } from "../_shared/clients.ts";
import { serveUnlessTest } from "../_shared/serve.ts";

interface ColumnDef {
  key: string;
  name: string;
  width: number;
  isDate?: boolean;
}

function addDataSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  tableName: string,
  columns: ColumnDef[],
  rows: Record<string, unknown>[]
): void {
  const sheet = workbook.addWorksheet(sheetName);

  const rowArrays = rows.map((r) =>
    columns.map((c) => {
      const v = r[c.key];
      if (v === null || v === undefined) return null;
      if (c.isDate) {
        const d = new Date(v as string);
        return isNaN(d.getTime()) ? v : d;
      }
      return v as string | number | boolean;
    })
  );

  if (rowArrays.length > 0) {
    sheet.addTable({
      name: tableName,
      ref: "A1",
      headerRow: true,
      style: { theme: "TableStyleMedium2", showRowStripes: true },
      columns: columns.map((c) => ({ name: c.name, filterButton: true })),
      rows: rowArrays,
    });
  } else {
    // addTable requires at least one data row in this ExcelJS version --
    // an empty category (e.g. a guild with zero sanctions) still gets a
    // clean styled header instead of erroring out the whole export.
    const headerRow = sheet.addRow(columns.map((c) => c.name));
    headerRow.font = { bold: true };
  }

  columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = c.width;
  });
}

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

export async function handler(req: Request): Promise<Response> {
  const json = makeJson(req);
  const logger = new EdgeLogger("guild-data-export", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = serviceClient();
  const caller = await resolveCaller(req);

  if (!caller.authenticated || !caller.role || caller.status !== "active") {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (!isAdminRole(caller.role)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  // An export reads every table of a guild into a workbook: the heaviest
  // request this API serves, and it had no rate limit (audit SEC-13).
  const throttle = await checkAndRecordIpAttempt(admin, extractClientIp(req.headers), {
    limit: 5,
    windowMs: 10 * 60_000,
  });
  if (!throttle.allowed) return json({ ok: false, error: "rate_limited" }, 429);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // No body is fine for guild_admin (their own guild is implied below).
  }
  if (
    body?.guild !== undefined &&
    body?.guild !== null &&
    (typeof body.guild !== "string" || !/^[A-Za-z0-9_]{2,12}$/.test(body.guild.trim()))
  ) {
    return json({ ok: false, error: "invalid_guild" }, 400);
  }

  const targetGuild: string | null = isGuildAdmin(caller.role) ? caller.guild : body?.guild || null;
  if (!targetGuild) {
    return json({ ok: false, error: "missing_guild" }, 400);
  }

  if (!isGuildAdmin(caller.role)) {
    const { data: g } = await admin.from("guilds").select("server_number").eq("id", targetGuild).maybeSingle();
    // FINDING M16, upstream half. `targetGuild` arrives from the request body
    // for anyone above guild_admin, and it is interpolated into a PostgREST
    // `.or()` filter further down. Requiring the guild to EXIST is what makes
    // that safe: a real guild id matches ^[A-Z0-9_]{2,12}$ and so can carry
    // none of the characters that grammar treats as separators. An unknown
    // name used to fall through here, because isGuildInScope short-circuits
    // to true for a super_admin regardless of what was asked for.
    if (!g) {
      return json({ ok: false, error: "guild_not_found" }, 404);
    }
    if (
      !isGuildInScope(
        { role: caller.role, guild: caller.guild, serverNumber: caller.serverNumber },
        targetGuild,
        g.server_number ?? null
      )
    ) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
  }

  logger.setContext({ tenantId: targetGuild, userId: caller.accountId });

  try {
    const byGuild =
      (col = "guild") =>
      (q: any) =>
        q.eq(col, targetGuild);

    const [
      roster,
      participation,
      events,
      weeklyScores,
      powerHistory,
      sanctions,
      absences,
      banned,
      nameHistory,
      squads,
      signups,
      transfers,
      settings,
    ] = await Promise.all([
      fetchAllRows(
        admin,
        "guild_members",
        "pseudo, uid, role, overall_power, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score, timezone_offset, power_updated_at, metrics_updated_at, created_at",
        byGuild()
      ),
      fetchAllRows(
        admin,
        "event_participants",
        "event_name, session_id, week_start, pseudo, participated, score, score_prep, score_pvp, late, excused, appointed, sub_present, created_at",
        byGuild()
      ),
      fetchAllRows(admin, "event_status", "event_name, session_id, is_active, stage, start_at, updated_at", byGuild()),
      fetchAllRows(
        admin,
        "weekly_scores",
        "pseudo, week_start, score_20, events_done, events_total, glory_score, computed_at",
        byGuild()
      ),
      fetchAllRows(
        admin,
        "player_metrics_history",
        "pseudo, week_start, total_power, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score, created_at",
        byGuild()
      ),
      fetchAllRows(admin, "sanctions", "pseudo, comment, created_by, created_at", byGuild()),
      fetchAllRows(admin, "player_absences", "pseudo, uid, start_date, end_date, kind, note, created_at", byGuild()),
      fetchAllRows(admin, "banned_players", "uid, pseudo, reason, created_by, created_at", byGuild()),
      fetchAllRows(admin, "player_name_history", "uid, old_pseudo, new_pseudo, changed_by, changed_at", byGuild()),
      fetchAllRows(admin, "shadowfront_squads", "week_start, squad, pseudo, role, is_commander, session_id", byGuild()),
      fetchAllRows(admin, "shadowfront_signups", "week_start, pseudo, availability, updated_at", byGuild()),
      fetchAllRows(
        admin,
        "guild_transfers",
        "uid, pseudo, source_guild, target_guild, status, resolved_at, created_at",
        (q) =>
          q.or(
            `source_guild.eq.${escapeOrFilterValue(targetGuild!)},target_guild.eq.${escapeOrFilterValue(targetGuild!)}`
          )
      ),
      fetchAllRows(admin, "guild_config", "key, value, updated_at", byGuild()),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "FGF Guild Management Tool";
    workbook.created = new Date();

    addDataSheet(
      workbook,
      "Roster",
      "RosterTable",
      [
        { key: "pseudo", name: "Pseudo", width: 20 },
        { key: "uid", name: "UID", width: 14 },
        { key: "role", name: "Role", width: 8 },
        { key: "overall_power", name: "Overall Power", width: 16 },
        { key: "tech_power", name: "Tech Power", width: 14 },
        { key: "champion_power", name: "Champion Power", width: 16 },
        { key: "crew_power", name: "Crew Power", width: 14 },
        { key: "flagship_power", name: "Flagship Power", width: 16 },
        { key: "fleet_rating", name: "Fleet Rating", width: 14 },
        { key: "glory_score", name: "Glory Score", width: 14 },
        { key: "timezone_offset", name: "Timezone (UTC)", width: 14 },
        { key: "power_updated_at", name: "Power Updated", width: 20, isDate: true },
        { key: "metrics_updated_at", name: "Metrics Updated", width: 20, isDate: true },
        { key: "created_at", name: "Member Since", width: 20, isDate: true },
      ],
      roster
    );

    addDataSheet(
      workbook,
      "Participation",
      "ParticipationTable",
      [
        { key: "event_name", name: "Event", width: 22 },
        { key: "session_id", name: "Session ID", width: 20 },
        { key: "week_start", name: "Week", width: 14, isDate: true },
        { key: "pseudo", name: "Pseudo", width: 20 },
        { key: "participated", name: "Participated", width: 14 },
        { key: "score", name: "Score", width: 12 },
        { key: "score_prep", name: "Score (Prep)", width: 14 },
        { key: "score_pvp", name: "Score (PvP)", width: 14 },
        { key: "late", name: "Late", width: 10 },
        { key: "excused", name: "Excused", width: 10 },
        { key: "appointed", name: "Appointed", width: 12 },
        { key: "sub_present", name: "Substitute", width: 12 },
        { key: "created_at", name: "Recorded", width: 20, isDate: true },
      ],
      participation
    );

    addDataSheet(
      workbook,
      "Events",
      "EventsTable",
      [
        { key: "event_name", name: "Event", width: 22 },
        { key: "session_id", name: "Session ID", width: 20 },
        { key: "is_active", name: "Active", width: 10 },
        { key: "stage", name: "Stage", width: 14 },
        { key: "start_at", name: "Start Time", width: 20, isDate: true },
        { key: "updated_at", name: "Updated", width: 20, isDate: true },
      ],
      events
    );

    addDataSheet(
      workbook,
      "Weekly Scores",
      "WeeklyScoresTable",
      [
        { key: "pseudo", name: "Pseudo", width: 20 },
        { key: "week_start", name: "Week", width: 14, isDate: true },
        { key: "score_20", name: "Score (/20)", width: 14 },
        { key: "events_done", name: "Events Done", width: 14 },
        { key: "events_total", name: "Events Total", width: 14 },
        { key: "glory_score", name: "Glory Score", width: 14 },
        { key: "computed_at", name: "Computed", width: 20, isDate: true },
      ],
      weeklyScores
    );

    addDataSheet(
      workbook,
      "Power History",
      "PowerHistoryTable",
      [
        { key: "pseudo", name: "Pseudo", width: 20 },
        { key: "week_start", name: "Week", width: 14, isDate: true },
        { key: "total_power", name: "Total Power", width: 16 },
        { key: "tech_power", name: "Tech Power", width: 14 },
        { key: "champion_power", name: "Champion Power", width: 16 },
        { key: "crew_power", name: "Crew Power", width: 14 },
        { key: "flagship_power", name: "Flagship Power", width: 16 },
        { key: "fleet_rating", name: "Fleet Rating", width: 14 },
        { key: "glory_score", name: "Glory Score", width: 14 },
        { key: "created_at", name: "Recorded", width: 20, isDate: true },
      ],
      powerHistory
    );

    addDataSheet(
      workbook,
      "Sanctions",
      "SanctionsTable",
      [
        { key: "pseudo", name: "Pseudo", width: 20 },
        { key: "comment", name: "Comment", width: 50 },
        { key: "created_by", name: "Issued By", width: 20 },
        { key: "created_at", name: "Date", width: 20, isDate: true },
      ],
      sanctions
    );

    addDataSheet(
      workbook,
      "Absences",
      "AbsencesTable",
      [
        { key: "pseudo", name: "Pseudo", width: 20 },
        { key: "uid", name: "UID", width: 14 },
        { key: "start_date", name: "Start Date", width: 16, isDate: true },
        { key: "end_date", name: "End Date", width: 16, isDate: true },
        { key: "kind", name: "Type", width: 12 },
        { key: "note", name: "Note", width: 40 },
        { key: "created_at", name: "Declared", width: 20, isDate: true },
      ],
      absences
    );

    addDataSheet(
      workbook,
      "Banned Players",
      "BannedTable",
      [
        { key: "uid", name: "UID", width: 14 },
        { key: "pseudo", name: "Pseudo", width: 20 },
        { key: "reason", name: "Reason", width: 40 },
        { key: "created_by", name: "Banned By", width: 20 },
        { key: "created_at", name: "Date", width: 20, isDate: true },
      ],
      banned
    );

    addDataSheet(
      workbook,
      "Name History",
      "NameHistoryTable",
      [
        { key: "uid", name: "UID", width: 14 },
        { key: "old_pseudo", name: "Old Pseudo", width: 20 },
        { key: "new_pseudo", name: "New Pseudo", width: 20 },
        { key: "changed_by", name: "Changed By", width: 20 },
        { key: "changed_at", name: "Date", width: 20, isDate: true },
      ],
      nameHistory
    );

    addDataSheet(
      workbook,
      "Shadowfront Squads",
      "SquadsTable",
      [
        { key: "week_start", name: "Week", width: 14, isDate: true },
        { key: "squad", name: "Squad", width: 12 },
        { key: "pseudo", name: "Pseudo", width: 20 },
        { key: "role", name: "Role", width: 14 },
        { key: "is_commander", name: "Commander", width: 14 },
        { key: "session_id", name: "Session ID", width: 20 },
      ],
      squads
    );

    addDataSheet(
      workbook,
      "Shadowfront Signups",
      "SignupsTable",
      [
        { key: "week_start", name: "Week", width: 14 },
        { key: "pseudo", name: "Pseudo", width: 20 },
        { key: "availability", name: "Availability", width: 16 },
        { key: "updated_at", name: "Updated", width: 20, isDate: true },
      ],
      signups
    );

    addDataSheet(
      workbook,
      "Transfers",
      "TransfersTable",
      [
        { key: "uid", name: "UID", width: 14 },
        { key: "pseudo", name: "Pseudo", width: 20 },
        { key: "source_guild", name: "From Guild", width: 16 },
        { key: "target_guild", name: "To Guild", width: 16 },
        { key: "status", name: "Status", width: 14 },
        { key: "resolved_at", name: "Resolved", width: 20, isDate: true },
        { key: "created_at", name: "Requested", width: 20, isDate: true },
      ],
      transfers
    );

    addDataSheet(
      workbook,
      "Settings",
      "SettingsTable",
      [
        { key: "key", name: "Setting", width: 28 },
        { key: "value", name: "Value", width: 40 },
        { key: "updated_at", name: "Updated", width: 20, isDate: true },
      ],
      settings
    );

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `${targetGuild}_export_${new Date().toISOString().slice(0, 10)}.xlsx`;

    logger.info("Guild data export generated", {
      guild: targetGuild,
      rosterCount: roster.length,
      participationCount: participation.length,
    });

    return new Response(buffer, {
      status: 200,
      headers: {
        ...getCorsHeaders(req),
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err: any) {
    logger.error("Guild data export failed", err, { guild: targetGuild });
    return json({ ok: false, error: "export_failed", message: err.message }, 500);
  }
}

serveUnlessTest(handler);
