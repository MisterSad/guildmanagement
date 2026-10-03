-- A guild_admin can crown a new R5 but can never demote the old one, so every
-- leadership handover leaves the guild with two R5s until a super_admin steps in.
--
-- The cause is `gm_protect_r5_role_change` (20260830054451), which rejects any
-- change to the `role` of a row that is currently R5 unless the caller is a
-- super_admin. Promoting someone TO R5 was never guarded -- OLD.role is not R5
-- -- so the rule was lopsided by construction: the guild could gain leaders but
-- not lose one.
--
-- The guard was written for audit finding R-01: the bulk-rank UI filtered R5
-- out, but the REST API did not. That concern stays covered. What changes is WHO
-- may move an R5:
--
--   * super_admin                          -- as before
--   * a guild_admin of that guild          -- new: the people who run the guild
--   * a server_admin of that guild's server -- new, same scoping
--
-- which is exactly `check_user_guild_write_access(OLD.guild)` -- the same
-- predicate the `gm_authenticated_update` RLS policy already applies to the row.
--
-- What stays forbidden is every path WITHOUT a human session: service_role
-- (Edge Functions, the Discord bot's role reconciliation, the OCR roster
-- import) and SECURITY DEFINER callers acting on behalf of someone else.
-- `check_user_guild_write_access` returns false when `auth.uid()` is NULL, so an
-- automated sync can never demote the leader; only a person accountable for the
-- guild can.
--
-- OLD.guild rather than NEW.guild: a write that moves the row to another guild
-- in the same statement must be authorised against the guild the leader is
-- leaving.

CREATE OR REPLACE FUNCTION public.gm_protect_r5_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF OLD.role = 'R5'
     AND NEW.role IS DISTINCT FROM OLD.role
     AND NOT public.check_user_guild_write_access(OLD.guild) THEN
    RAISE EXCEPTION 'r5_role_change_forbidden'
      USING ERRCODE = '42501',
            HINT = 'Only an administrator of this guild can change the role of its R5 leader.';
  END IF;
  RETURN NEW;
END;
$function$;

-- CREATE OR REPLACE keeps the existing ACL, but restate it: 20260926140000
-- revoked it from the API roles, and a trigger function must stay unreachable
-- over /rest/v1/rpc.
REVOKE EXECUTE ON FUNCTION public.gm_protect_r5_role_change() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
