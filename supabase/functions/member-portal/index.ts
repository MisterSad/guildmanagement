import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/**
 * Resolve the authenticated player's identity from their account.
 * The player signs in with identifier + password via auth-login, which
 * provisions a shadow GoTrue user; the JWT of that session maps back to
 * the accounts row (auth_user_id), which carries the in-game UID.
 *
 * The in-game UID is NEVER accepted as an access credential anymore:
 * knowing a UID no longer grants access to someone else's portal data.
 */
async function getIdentity(
  req: Request,
  admin: ReturnType<typeof createClient>
): Promise<{ uid: string | null; pseudo: string | null; guild: string | null } | null> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return null;

  const jwt = match[1];
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: { user }, error } = await anon.auth.getUser(jwt);
  if (error || !user) return null;

  const { data: acc } = await admin
    .from("accounts")
    .select("uid, status, guild")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!acc || acc.status !== "active" || !acc.uid) return null;

  return { uid: acc.uid, pseudo: null, guild: acc.guild ?? null };
}

async function getPlayer(admin: ReturnType<typeof createClient>, uid: string) {
  const { data, error } = await admin
    .from("guild_members")
    .select("pseudo, guild, overall_power")
    .eq("uid", uid)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")   return json({ ok: false, error: "method_not_allowed" }, 405);

  let action = "";
  let payload: any = {};
  try {
    const body = await req.json();
    action = (body?.action ?? "").toString();
    payload = body?.payload ?? {};
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  if (!action) return json({ ok: false, error: "missing_action" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Identity always comes from the signed-in account, never from a client-supplied UID.
  const identity = await getIdentity(req, admin);
  if (!identity || !identity.uid) {
    return json({ ok: false, error: "unauthorized" }, 200);
  }
  const uid = identity.uid;

  if (action === "get-active-sessions") {
    // 1. Look up player in guild_members
    const member = await getPlayer(admin, uid);
    if (!member) {
      return json({ ok: false, error: "player_not_found" }, 200);
    }

    // 2. Look up active event sessions for that guild
    const { data: activeSessions, error: sErr } = await admin
      .from("event_status")
      .select("event_name, session_id, start_at")
      .eq("guild", member.guild)
      .eq("is_active", true);

    if (sErr) return json({ ok: false, error: "db_error", message: sErr.message }, 500);

    // 3. For each active session, retrieve the player's participant entry
    if (!activeSessions || activeSessions.length === 0) {
      return json({ ok: true, pseudo: member.pseudo, guild: member.guild, overall_power: member.overall_power, sessions: [] });
    }

    const sessionIds = activeSessions.map(s => s.session_id);
    const { data: participants, error: pErr } = await admin
      .from("event_participants")
      .select("*")
      .eq("pseudo", member.pseudo)
      .in("session_id", sessionIds);

    if (pErr) return json({ ok: false, error: "db_error", message: pErr.message }, 500);

    // Combine active session info with participant row
    const sessions = activeSessions.map(sess => {
      const part = (participants || []).find(p => p.session_id === sess.session_id);
      return {
        event_name: sess.event_name,
        session_id: sess.session_id,
        start_at: sess.start_at,
        current_data: part || null
      };
    });

    return json({ ok: true, pseudo: member.pseudo, guild: member.guild, overall_power: member.overall_power, sessions });
  }

  if (action === "submit-scores") {
    const eventName = (payload?.event_name ?? "").toString().trim();
    const sessionId = (payload?.session_id ?? "").toString().trim();

    if (!eventName || !sessionId) {
      return json({ ok: false, error: "missing_parameters" }, 400);
    }

    // 1. Verify player membership
    const member = await getPlayer(admin, uid);
    if (!member) {
      return json({ ok: false, error: "player_not_found" }, 400);
    }

    // 2. Verify that the session is active
    const { data: activeSession, error: sErr } = await admin
      .from("event_status")
      .select("is_active")
      .eq("guild", member.guild)
      .eq("event_name", eventName)
      .eq("session_id", sessionId)
      .maybeSingle();

    if (sErr || !activeSession || !activeSession.is_active) {
      return json({ ok: false, error: "session_inactive" }, 400);
    }

    // 3. Prepare update data
    const update: any = {
      is_pending: true
    };

    if (payload.participated !== undefined) {
      update.participated = payload.participated ? 1 : 0;
    }
    if (payload.score !== undefined) {
      update.score = payload.score;
    }
    if (payload.score_prep !== undefined) {
      update.score_prep = payload.score_prep;
    }
    if (payload.score_pvp !== undefined) {
      update.score_pvp = payload.score_pvp;
    }
    if (payload.late !== undefined) {
      update.late = !!payload.late;
    }
    if (payload.excused !== undefined) {
      update.excused = !!payload.excused;
    }
    if (payload.appointed !== undefined) {
      update.appointed = !!payload.appointed;
    }

    // 4. Update row in event_participants
    const { error: uErr } = await admin
      .from("event_participants")
      .update(update)
      .eq("event_name", eventName)
      .eq("session_id", sessionId)
      .eq("pseudo", member.pseudo);

    if (uErr) {
      return json({ ok: false, error: "update_failed", message: uErr.message }, 500);
    }

    return json({ ok: true });
  }

  if (action === "update-power") {
    const power = parseInt(payload?.power) || 0;
    if (!uid) return json({ ok: false, error: "missing_uid" }, 400);

    // Update the player's overall_power in guild_members
    const { error: uErr } = await admin
      .from("guild_members")
      .update({ overall_power: power })
      .eq("uid", uid);

    if (uErr) {
      return json({ ok: false, error: "update_failed", message: uErr.message }, 500);
    }

    return json({ ok: true });
  }

  if (action === "get-transfer-guilds") {
    // Get player's current guild and its server number
    const member = await getPlayer(admin, uid);
    if (!member) return json({ ok: false, error: "player_not_found" }, 200);

    const { data: sourceGuild, error: gErr } = await admin
      .from("guilds")
      .select("server_number")
      .eq("id", member.guild)
      .maybeSingle();

    if (gErr || !sourceGuild || !sourceGuild.server_number) {
      return json({ ok: false, error: "server_not_found" }, 200);
    }

    // Get all other guilds on the same server
    const { data: guilds, error: guildsErr } = await admin
      .from("guilds")
      .select("id")
      .eq("server_number", sourceGuild.server_number)
      .neq("id", member.guild);

    if (guildsErr) {
        return json({ ok: false, error: "db_error: " + guildsErr.message }, 200);
    }

    return json({ ok: true, guilds: guilds });
  }

  if (action === "submit-transfer-request") {
    const targetGuild = (payload?.targetGuild ?? "").toString().trim();

    if (!targetGuild) return json({ ok: false, error: "missing_target_guild" }, 400);

    // Call the RPC to handle the complex logic securely
    const { data, error } = await admin.rpc("request_guild_transfer", {
      p_uid: uid,
      p_target_guild: targetGuild
    });

    if (error) {
      return json({ ok: false, error: "rpc_failed: " + error.message, message: error.message }, 200);
    }

    return json(data); // Returns the jsonb output from the RPC
  }

  if (action === "get-history") {
    // Player's participation history, grouped per event type, for charts.
    const member = await getPlayer(admin, uid);
    if (!member) return json({ ok: false, error: "player_not_found" }, 200);

    const { data: rows, error: hErr } = await admin
      .from("event_participants")
      .select("event_name, session_id, week_start, participated, score, score_prep, score_pvp, late, excused, sub_present, appointed")
      .eq("pseudo", member.pseudo)
      .order("week_start", { ascending: false });

    if (hErr) return json({ ok: false, error: "db_error", message: hErr.message }, 500);

    // Keep most recent 60 rows per player; group by event_name (case-insensitive).
    // Events with a score column are the only ones that produce progression charts.
    const byEvent: Record<string, any[]> = {};
    const hasScoreEvent = (name: string): boolean => {
      const n = (name || "").toUpperCase();
      if (n.indexOf("SVS") !== -1 || n.indexOf("GVG") !== -1) return true;
      if (n.indexOf("GLORY") !== -1) return true;
      // DTR / Shadowfront / Arms Race have no player score
      return false;
    };
    (rows || []).forEach((r: any) => {
      const key = (r.event_name || "Other").toUpperCase();
      if (!byEvent[key]) byEvent[key] = [];
      byEvent[key].push({
        session_id: r.session_id,
        week_start: r.week_start,
        participated: r.participated > 0,
        score: (r.score || 0) + (r.score_prep || 0) + (r.score_pvp || 0),
        late: !!r.late,
        excused: !!r.excused,
        sub_present: !!r.sub_present,
        appointed: !!r.appointed
      });
    });

    const summary: Record<string, any> = {};
    Object.keys(byEvent).forEach((key) => {
      const list = byEvent[key];
      const total = list.length;
      const attended = list.filter((r: any) => r.participated || r.sub_present).length;
      summary[key] = {
        count: total,
        attended: attended,
        rate: total > 0 ? Math.round((attended / total) * 100) : 0,
        has_score: hasScoreEvent(key),
        history: list.slice(0, 60)
      };
    });

    return json({ ok: true, events: summary, overall: (rows || []).length });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
