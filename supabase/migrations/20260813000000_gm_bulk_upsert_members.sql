-- 20260813000000_gm_bulk_upsert_members.sql
-- Bulk member power update and insert via OCR

CREATE OR REPLACE FUNCTION public.gm_bulk_upsert_members(p_members jsonb, p_guild text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_caller_role text;
  v_user_guild text;
  v_target_guild text;
  v_item jsonb;
  v_pseudo text;
  v_power bigint;
  v_uid text;
  v_updated integer := 0;
  v_inserted integer := 0;
  v_skipped integer := 0;
BEGIN
  -- Determine caller role and assigned guild
  SELECT role, guild INTO v_caller_role, v_user_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
  LIMIT 1;

  IF v_user_guild IS NULL THEN
    v_user_guild := COALESCE((current_setting('request.jwt.claims', true)::jsonb)->>'guild', 'ALPHA');
  END IF;

  -- Determine target guild: super_admin can specify p_guild, guild_admin is strictly bound to v_user_guild
  IF v_caller_role = 'super_admin' AND p_guild IS NOT NULL AND length(trim(p_guild)) > 0 THEN
    v_target_guild := trim(p_guild);
  ELSE
    v_target_guild := v_user_guild;
  END IF;

  IF NOT public.check_user_guild_write_access(v_target_guild) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  IF NOT public.is_subscription_active(v_target_guild) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'subscription_inactive');
  END IF;

  IF p_members IS NULL OR jsonb_array_length(p_members) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'updated', 0, 'inserted', 0, 'skipped', 0);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_members)
  LOOP
    v_pseudo := trim(v_item->>'pseudo');
    v_power := COALESCE((v_item->>'overall_power')::bigint, 0);
    v_uid := NULLIF(trim(v_item->>'uid'), '');

    IF v_pseudo IS NULL OR length(v_pseudo) = 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Check if member exists in target guild by pseudo
    IF EXISTS (
      SELECT 1 FROM public.guild_members
      WHERE guild = v_target_guild AND lower(pseudo) = lower(v_pseudo)
    ) THEN
      UPDATE public.guild_members
      SET overall_power = v_power,
          power_updated_at = now()
      WHERE guild = v_target_guild AND lower(pseudo) = lower(v_pseudo);
      v_updated := v_updated + 1;
    ELSE
      -- Insert new member
      IF v_uid IS NULL THEN
        v_uid := 'TEMP-' || substring(md5(v_pseudo || v_target_guild) from 1 for 10);
      END IF;

      INSERT INTO public.guild_members (pseudo, uid, overall_power, guild, role, created_at)
      VALUES (v_pseudo, v_uid, v_power, v_target_guild, 'R1', now())
      ON CONFLICT (guild, pseudo) DO UPDATE
      SET overall_power = EXCLUDED.overall_power,
          power_updated_at = now();
          
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'guild', v_target_guild,
    'updated', v_updated,
    'inserted', v_inserted,
    'skipped', v_skipped
  );
END;
$$;

REVOKE ALL ON FUNCTION public.gm_bulk_upsert_members(jsonb, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_bulk_upsert_members(jsonb, text) TO authenticated;
