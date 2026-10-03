-- ═══════════════════════════════════════════════════════════════════════════
-- Phase D5 — single-use invitation codes for additional admins
--
-- The table already exists: D6 created `account_link_codes` with both kinds
-- and the CHECK constraints each one needs. This adds the `admin_invite`
-- half — issuing with a cap, and redeeming into a brand-new account.
--
-- NO DEPENDENCE ON A DISCORD SERVER. The owner's constraint was that adding a
-- second admin to a tenant must not require the bot to be present in some
-- particular Discord guild, or any mapping between FGF guilds and Discord
-- servers. **The code IS the link.** That is why the worker's `/setup-server`
-- provisioning plays no part here.
--
-- THE NEW ACCOUNT IS BORN WITHOUT A PASSWORD. `password_hash` and
-- `password_enc` are never written, which is the whole point of the migration:
-- accounts created from here on can only ever sign in with Discord.
-- `establishShadowSession` reads neither column, so sessions work normally.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Account id generation ─────────────────────────────────────────────────
--
-- MUST be called INSIDE the transaction that inserts the account. Generating
-- an id in the Edge Function and inserting afterwards is a TOCTOU race against
-- `idx_accounts_lower_id` (UNIQUE on lower(id)) that two simultaneous
-- redemptions would lose.
--
-- `accounts.id` stays the human-readable text key it has always been. It is a
-- textual foreign key referenced from many tables, so replacing it with an
-- opaque id plus a display_name is a migration of its own, not something to
-- smuggle in here. Recorded deliberately.
CREATE OR REPLACE FUNCTION public.gm_generate_account_id(p_base text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_base      text;
    v_candidate text;
    v_suffix    text;
    v_alphabet  CONSTANT text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    i           int;
    j           int;
BEGIN
    -- Fold accented Latin to ASCII FIRST. Stripping straight to [A-Za-z0-9_]
    -- turns a perfectly ordinary Discord name like 'Ärès_Actual' into
    -- 'rs_Actual' -- unrecognisable to its owner. `translate` is used rather
    -- than the `unaccent` extension: it is deterministic, needs no extension
    -- installed, and needs no schema qualification under `search_path = ''`.
    v_base := translate(
        COALESCE(p_base, ''),
        'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿÑñÇçŠšŽžÐðÞþ',
        'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuYyyNnCcSsZzDdTt'
    );
    -- Two-letter expansions translate() cannot express.
    v_base := replace(replace(replace(v_base, 'Æ', 'AE'), 'æ', 'ae'), 'ß', 'ss');
    v_base := replace(replace(v_base, 'Œ', 'OE'), 'œ', 'oe');
    -- Then keep only what the rest of the system already tolerates in an id.
    v_base := regexp_replace(v_base, '[^A-Za-z0-9_]', '', 'g');
    v_base := left(v_base, 20);
    IF length(v_base) < 3 THEN
        v_base := 'Commander';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE lower(a.id) = lower(v_base)) THEN
        RETURN v_base;
    END IF;

    -- Collision: append a short random suffix. 31^4 is ample for the handful
    -- of people who share a Discord display name here.
    FOR i IN 1..12 LOOP
        v_suffix := '';
        FOR j IN 1..4 LOOP
            v_suffix := v_suffix || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
        END LOOP;
        v_candidate := left(v_base, 20) || '_' || v_suffix;
        IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE lower(a.id) = lower(v_candidate)) THEN
            RETURN v_candidate;
        END IF;
    END LOOP;

    -- Guaranteed fallback: a Discord snowflake is unique by construction, so
    -- this branch cannot loop forever the way a random suffix theoretically
    -- could.
    RETURN 'd' || COALESCE(NULLIF(regexp_replace(COALESCE(p_base, ''), '\D', '', 'g'), ''), extract(epoch from clock_timestamp())::bigint::text);
END;
$$;

-- ── Issue an invitation, with a cap ───────────────────────────────────────
-- The cap is enforced here rather than in the Edge Function because two
-- concurrent issues would otherwise both read "4 outstanding" and both write.
CREATE OR REPLACE FUNCTION public.gm_issue_admin_invite(
    p_code_hash  text,
    p_guild      text,
    p_role       text,
    p_issued_by  text,
    p_expires_at timestamptz,
    p_max_open   integer
)
RETURNS TABLE (ok boolean, open_codes integer, err text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_open integer;
BEGIN
    IF p_role NOT IN ('guild_admin', 'server_admin', 'super_admin') THEN
        RETURN QUERY SELECT false, 0, 'invalid_role'::text;
        RETURN;
    END IF;

    -- Lock the guild row so the count below cannot be read twice concurrently.
    PERFORM 1 FROM public.guilds g WHERE g.id = p_guild FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 0, 'guild_not_found'::text;
        RETURN;
    END IF;

    SELECT count(*)::int INTO v_open
    FROM public.account_link_codes c
    WHERE c.kind = 'admin_invite'
      AND c.guild = p_guild
      AND c.used_at IS NULL
      AND c.expires_at > now();

    IF v_open >= p_max_open THEN
        RETURN QUERY SELECT false, v_open, 'too_many_open_codes'::text;
        RETURN;
    END IF;

    INSERT INTO public.account_link_codes (code_hash, kind, guild, role, issued_by, expires_at)
    VALUES (p_code_hash, 'admin_invite', p_guild, p_role, p_issued_by, p_expires_at);

    RETURN QUERY SELECT true, v_open + 1, NULL::text;
END;
$$;

-- ── Redeem an invitation into a new account ───────────────────────────────
CREATE OR REPLACE FUNCTION public.gm_redeem_admin_invite(
    p_code_hash       text,
    p_discord_user_id text,
    p_discord_username text
)
RETURNS TABLE (ok boolean, account_id text, role text, guild text, err text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_code   record;
    v_new_id text;
    v_server text;
BEGIN
    SELECT c.id, c.guild, c.role INTO v_code
    FROM public.account_link_codes c
    WHERE c.code_hash = p_code_hash
      AND c.kind = 'admin_invite'
      AND c.used_at IS NULL
      AND c.expires_at > now()
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, 'code_invalid'::text;
        RETURN;
    END IF;

    -- One Discord identity, one account. Someone already holding an account
    -- must not be able to spend an invite and end up with two.
    IF EXISTS (SELECT 1 FROM public.discord_account_links l WHERE l.discord_user_id = p_discord_user_id) THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, 'discord_already_linked'::text;
        RETURN;
    END IF;

    SELECT g.server_number INTO v_server FROM public.guilds g WHERE g.id = v_code.guild;

    -- Generated here, inside the transaction, against the UNIQUE index.
    v_new_id := public.gm_generate_account_id(p_discord_username);

    -- No password of any kind is written: this account is Discord-only from
    -- birth, which is the entire point of the migration.
    INSERT INTO public.accounts (id, role, guild, server_number, status)
    VALUES (v_new_id, v_code.role, v_code.guild, v_server, 'active');

    INSERT INTO public.discord_account_links (discord_user_id, account_id)
    VALUES (p_discord_user_id, v_new_id);

    UPDATE public.account_link_codes
    SET used_at = now(), used_by_discord_user_id = p_discord_user_id, account_id = v_new_id
    WHERE id = v_code.id;

    RETURN QUERY SELECT true, v_new_id, v_code.role, v_code.guild, NULL::text;
END;
$$;

-- ── service_role only ─────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.gm_generate_account_id(text)                                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_issue_admin_invite(text, text, text, text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_redeem_admin_invite(text, text, text)                            FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_generate_account_id(text)                                        TO service_role;
GRANT EXECUTE ON FUNCTION public.gm_issue_admin_invite(text, text, text, text, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.gm_redeem_admin_invite(text, text, text)                            TO service_role;

-- ── Assertions ────────────────────────────────────────────────────────────
DO $verify$
DECLARE
    v_n int;
BEGIN
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('gm_generate_account_id', 'gm_issue_admin_invite', 'gm_redeem_admin_invite')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    IF v_n <> 0 THEN RAISE EXCEPTION '% invite function(s) still executable by anon/authenticated', v_n; END IF;

    -- An invited account must never be given a password.
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gm_redeem_admin_invite'
      AND pg_get_functiondef(p.oid) ~ '(password_hash|password_enc)';
    IF v_n <> 0 THEN RAISE EXCEPTION 'gm_redeem_admin_invite must not write any password column'; END IF;

    -- The id must be generated inside the transaction, not handed in.
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gm_redeem_admin_invite'
      AND pg_get_functiondef(p.oid) ~ 'gm_generate_account_id';
    IF v_n <> 1 THEN RAISE EXCEPTION 'gm_redeem_admin_invite must generate the id in-transaction'; END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
