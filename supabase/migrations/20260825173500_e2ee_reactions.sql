-- Migration: 20260825173500_e2ee_reactions.sql
-- Description: Creates table e2ee_message_reactions, RLS policies, and gm_toggle_e2ee_reaction RPC for emoji reactions in Leader Hall.

-- 1. Table: e2ee_message_reactions
CREATE TABLE IF NOT EXISTS public.e2ee_message_reactions (
    id BIGSERIAL PRIMARY KEY,
    message_id BIGINT NOT NULL REFERENCES public.e2ee_messages(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES public.e2ee_conversations(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, account_id, emoji)
);

ALTER TABLE public.e2ee_message_reactions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_e2ee_reactions_msg
    ON public.e2ee_message_reactions (message_id);

CREATE INDEX IF NOT EXISTS idx_e2ee_reactions_conv
    ON public.e2ee_message_reactions (conversation_id);

-- 2. RLS Policy: Authenticated users can view reactions in conversations they have access to
DROP POLICY IF EXISTS e2ee_message_reactions_select ON public.e2ee_message_reactions;
CREATE POLICY e2ee_message_reactions_select ON public.e2ee_message_reactions
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.e2ee_conversations c
            WHERE c.id = conversation_id
              AND (
                  c.type = 'global'
                  OR EXISTS (
                      SELECT 1 FROM public.e2ee_conversation_members m
                      JOIN public.accounts a ON a.id = m.account_id
                      WHERE m.conversation_id = c.id
                        AND a.auth_user_id = auth.uid()
                        AND a.status = 'active'
                  )
              )
        )
    );

-- 3. RPC: Toggle emoji reaction (Idempotent: adds if not present, removes if already reacted)
CREATE OR REPLACE FUNCTION public.gm_toggle_e2ee_reaction(
    p_message_id bigint,
    p_emoji text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_auth_id uuid;
    v_caller_id text;
    v_caller_role text;
    v_msg record;
    v_conv record;
    v_existing_id bigint;
    v_clean_emoji text;
BEGIN
    v_caller_auth_id := auth.uid();
    IF v_caller_auth_id IS NULL THEN
        RAISE EXCEPTION 'unauthenticated: valid JWT session required';
    END IF;

    -- Resolve caller account
    SELECT id, role INTO v_caller_id, v_caller_role
    FROM public.accounts
    WHERE auth_user_id = v_caller_auth_id AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'forbidden: caller is not an active account';
    END IF;

    v_clean_emoji := trim(p_emoji);
    IF v_clean_emoji = '' OR length(v_clean_emoji) > 16 THEN
        RAISE EXCEPTION 'invalid emoji';
    END IF;

    -- Fetch message
    SELECT * INTO v_msg
    FROM public.e2ee_messages
    WHERE id = p_message_id;

    IF v_msg.id IS NULL THEN
        RAISE EXCEPTION 'message not found';
    END IF;

    -- Verify access to conversation
    SELECT * INTO v_conv
    FROM public.e2ee_conversations
    WHERE id = v_msg.conversation_id;

    IF v_conv.id IS NULL THEN
        RAISE EXCEPTION 'conversation not found';
    END IF;

    IF v_conv.type <> 'global' THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.e2ee_conversation_members
            WHERE conversation_id = v_msg.conversation_id AND account_id = v_caller_id
        ) THEN
            RAISE EXCEPTION 'forbidden: not a member of this conversation';
        END IF;
    END IF;

    -- Check existing reaction
    SELECT id INTO v_existing_id
    FROM public.e2ee_message_reactions
    WHERE message_id = p_message_id
      AND account_id = v_caller_id
      AND emoji = v_clean_emoji;

    IF v_existing_id IS NOT NULL THEN
        DELETE FROM public.e2ee_message_reactions WHERE id = v_existing_id;
        RETURN jsonb_build_object('action', 'removed', 'emoji', v_clean_emoji, 'message_id', p_message_id);
    ELSE
        INSERT INTO public.e2ee_message_reactions (
            message_id,
            conversation_id,
            account_id,
            emoji
        ) VALUES (
            p_message_id,
            v_msg.conversation_id,
            v_caller_id,
            v_clean_emoji
        );
        RETURN jsonb_build_object('action', 'added', 'emoji', v_clean_emoji, 'message_id', p_message_id);
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_toggle_e2ee_reaction(bigint, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_toggle_e2ee_reaction(bigint, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ROLLBACK SQL:
-- DROP TABLE IF EXISTS public.e2ee_message_reactions CASCADE;
-- DROP FUNCTION IF EXISTS public.gm_toggle_e2ee_reaction(bigint, text);
