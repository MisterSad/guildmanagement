import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  if (action === "get-active-sessions") {
    const uid = (payload?.uid ?? "").toString().trim();
    if (!uid) return json({ ok: false, error: "missing_uid" }, 400);

    // 1. Look up player in guild_members
    const { data: member, error: mErr } = await admin
      .from("guild_members")
      .select("pseudo, guild, overall_power")
      .eq("uid", uid)
      .maybeSingle();

    if (mErr || !member) {
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
    const uid = (payload?.uid ?? "").toString().trim();
    const eventName = (payload?.event_name ?? "").toString().trim();
    const sessionId = (payload?.session_id ?? "").toString().trim();
    
    if (!uid || !eventName || !sessionId) {
      return json({ ok: false, error: "missing_parameters" }, 400);
    }

    // 1. Verify player membership
    const { data: member, error: mErr } = await admin
      .from("guild_members")
      .select("pseudo, guild")
      .eq("uid", uid)
      .maybeSingle();

    if (mErr || !member) {
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
    const uid = (payload?.uid ?? "").toString().trim();
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

  return json({ ok: false, error: "unknown_action" }, 400);
});
