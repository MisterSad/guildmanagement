-- 20260913000000_drop_leader_hall_e2ee.sql
-- Lot C: purge the Leader Hall / E2EE infrastructure (front-end removed 2026-09).
-- KEEP public.gm_is_leader_caller(): still used by diplomatic_treaties RLS
-- (see 20260825153000_diplomatic_treaties.sql: diplomatic_treaties_select).
-- IRREVERSIBLE (data loss): take a backup before applying.

-- 1) Drop the leader/e2ee RPCs (all except the shared gm_is_leader_caller).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'gm_can_access_e2ee_conversation',
        'gm_get_e2ee_prekey_bundle',
        'gm_create_e2ee_conversation',
        'gm_leave_e2ee_conversation',
        'gm_delete_e2ee_conversation',
        'gm_toggle_block_leader',
        'gm_publish_e2ee_prekey_bundle',
        'gm_rename_e2ee_conversation',
        'gm_add_e2ee_group_member',
        'gm_add_e2ee_group_members',
        'gm_remove_e2ee_group_member',
        'gm_toggle_e2ee_reaction',
        'gm_list_eligible_leaders'
      ])
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END $$;

-- 2) Defensive: detach from Realtime publication if it ever existed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime DROP TABLE
        public.e2ee_message_reactions,
        public.e2ee_messages,
        public.e2ee_conversation_members,
        public.e2ee_conversations,
        public.e2ee_blocked_accounts,
        public.e2ee_one_time_prekeys,
        public.e2ee_prekey_bundles;
    EXCEPTION WHEN undefined_object THEN NULL; WHEN undefined_table THEN NULL;
    END;
  END IF;
END $$;

-- 3) Drop the 7 E2EE tables (children first; CASCADE cleans FKs/indexes/policies).
DROP TABLE IF EXISTS public.e2ee_message_reactions CASCADE;
DROP TABLE IF EXISTS public.e2ee_messages CASCADE;
DROP TABLE IF EXISTS public.e2ee_conversation_members CASCADE;
DROP TABLE IF EXISTS public.e2ee_conversations CASCADE;
DROP TABLE IF EXISTS public.e2ee_blocked_accounts CASCADE;
DROP TABLE IF EXISTS public.e2ee_one_time_prekeys CASCADE;
DROP TABLE IF EXISTS public.e2ee_prekey_bundles CASCADE;

-- 4) PostgREST schema cache refresh (REQUIRED: canonical_replay asserts this).
NOTIFY pgrst, 'reload schema';
